import { Command } from '@oclif/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as eb from '../lib/eb-puppetmaster/index.js';
import * as db from '../lib/db.js';
import { saveRefreshedSession } from '../lib/login-helper.js';
import { STANDARD_PATHS } from './agent/guide.js';
import * as pi from '../lib/eb-puppetmaster/process-instance.js';

export default class McpCommand extends Command {
  static override description =
    'Start an MCP (Model Context Protocol) stdio server exposing e-Builder automation tools to AI agents';
  static override examples = ['<%= config.bin %> <%= command.id %>'];

  public async run(): Promise<void> {
    const server = new McpServer({
      name: 'eb-cli',
      version: '0.1.0',
    });

    server.tool(
      'eb_session_list',
      'List all stored e-Builder sessions in eb-cli, including username, environment (us1, us2, ca, gov), account, and session ID.',
      {
        username: z.string().optional().describe('Filter sessions by username'),
      },
      async ({ username }) => {
        let sessions: db.SessionRow[];
        if (username) {
          sessions = db.getSessionsByUsername(username) as db.SessionRow[];
        } else {
          sessions = db.getSessions() as db.SessionRow[];
        }
        const cleaned = sessions.map((s) => ({
          id: s.id,
          username: s.username,
          environment: s.environment,
          account: s.account,
          created_at: s.created_at,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(cleaned, null, 2) }],
        };
      },
    );

    server.tool(
      'eb_session_test',
      'Verify whether e-Builder session cookies are valid and refresh them without interactive prompts.',
      {
        username: z.string().optional().describe('Username to test sessions for'),
        deleteInvalid: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Delete sessions redirected to a login page (defaults to false). Network, timeout, and server errors never delete.',
          ),
      },
      async ({ username, deleteInvalid }) => {
        let sessions: db.SessionRow[];
        if (username) {
          sessions = db.getSessionsByUsername(username) as db.SessionRow[];
        } else {
          sessions = db.getSessions() as db.SessionRow[];
        }

        const results = [];
        for (const session of sessions) {
          const env = eb.getEnvironment(session.environment);
          const cookies = JSON.parse(session.session_cookies);
          const base = {
            id: session.id,
            username: session.username,
            environment: session.environment,
            account: session.account,
          };
          let check: eb.SessionCheckResult;
          try {
            check = await eb.isLoggedIn(env, true, cookies);
          } catch (err: any) {
            check = {
              isLoggedIn: false,
              reason: eb.classifyNavigationError(err) ?? 'unknown',
              errorMessage: err?.message,
              newCookies: [],
            };
          }

          if (check.isLoggedIn) {
            await saveRefreshedSession(session, check.newCookies);
            results.push({
              ...base,
              valid: true,
              refreshed: true,
              deleted: false,
              reason: check.reason,
            });
            continue;
          }

          // Only a real redirect to a login page proves the cookies are dead.
          const shouldDelete = Boolean(deleteInvalid) && check.reason === 'redirected_to_login';
          if (shouldDelete) {
            db.deleteSessionById(session.id);
          }
          results.push({
            ...base,
            valid: false,
            refreshed: false,
            deleted: shouldDelete,
            reason: check.reason,
            error: eb.sessionCheckErrorFor(check, `https://${env}.${eb.baseurl}`).message,
          });
        }

        await eb.BrowserManager.getInstance().closeBrowser();

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      },
    );

    server.tool(
      'eb_page_inspect',
      'Navigate to an e-Builder page or relative path, automatically unwrap ASP.NET iframes (#contentFrame), and extract a clean structured AST of all form inputs, RadComboBoxes, dropdowns, buttons, tables, alerts, and breadcrumbs.',
      {
        url: z
          .string()
          .optional()
          .describe('e-Builder relative path (e.g. /da2/Processes/ProcessesMain.aspx) or full URL'),
        sessionId: z.number().optional().describe('Specific session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
        account: z
          .string()
          .optional()
          .describe('Select session by account name (case-insensitive substring, e.g. "prod")'),
        waitForSelector: z
          .string()
          .optional()
          .describe('CSS selector to wait for before inspecting'),
        screenshot: z.boolean().optional().describe('Capture screenshot to temporary file'),
      },
      async ({ url, sessionId, username, account, waitForSelector, screenshot }) => {
        const session = resolveMcpSession(sessionId, username, account);
        const env = eb.getEnvironment(session.environment);
        const cookies = getMcpStoredCookies(session);

        let screenshotPath: string | undefined;
        if (screenshot) {
          const os = await import('os');
          const path = await import('path');
          screenshotPath = path.join(os.tmpdir(), `eb-inspect-${Date.now()}.png`);
        }

        try {
          const result = await eb.executeInSession({
            env,
            cookies,
            headless: true,
            url,
            waitForSelector,
            inspect: true,
            screenshotPath,
          });

          if (result.cookies && result.cookies.length > 0) {
            db.updateSessionCookies(session.id, JSON.stringify(result.cookies));
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session: {
                      id: session.id,
                      username: session.username,
                      environment: session.environment,
                      origin: `https://${env}.${eb.baseurl}`,
                      account: session.account,
                    },
                    url: result.url,
                    title: result.title,
                    frameUrl: result.frameUrl,
                    screenshotPath: result.screenshotPath,
                    inspection: result.inspection,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } finally {
          await eb.BrowserManager.getInstance().closeBrowser();
        }
      },
    );

    server.tool(
      'eb_session_exec',
      'Execute a DOM JavaScript snippet or Puppeteer script inside an authenticated e-Builder session. In DOM mode, has access to the in-browser "eb" helper (eb.findField, eb.getRadComboBox, eb.setRadComboBox, eb.getTable, eb.getContentDocument).',
      {
        url: z.string().optional().describe('e-Builder relative path or full URL'),
        eval: z
          .string()
          .optional()
          .describe(
            'JavaScript to evaluate. DOM mode: `(arg, eb) => ...`. Puppeteer mode: `async ({ page, arg, eb, fs }) => ...`. `export default` / `module.exports =` wrappers are accepted.',
          ),
        mode: z
          .enum(['dom', 'puppeteer'])
          .optional()
          .describe('Execution mode (auto-detected from the script when omitted)'),
        arg: z.unknown().optional().describe('Argument passed to the script function'),
        waitForSelector: z.string().optional().describe('CSS selector to wait for'),
        sessionId: z.number().optional().describe('Specific session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
        account: z
          .string()
          .optional()
          .describe('Select session by account name (case-insensitive substring, e.g. "prod")'),
        dialogPolicy: z
          .enum(['dismiss', 'accept', 'manual'])
          .optional()
          .default('dismiss')
          .describe('How to answer alert/confirm/prompt dialogs'),
        screenshot: z.string().optional().describe('Save full-page screenshot to this path'),
      },
      async ({
        url,
        eval: scriptCode,
        mode,
        arg,
        waitForSelector,
        sessionId,
        username,
        account,
        dialogPolicy,
        screenshot,
      }) => {
        const session = resolveMcpSession(sessionId, username, account);
        const env = eb.getEnvironment(session.environment);
        const cookies = getMcpStoredCookies(session);
        const resolvedMode: eb.ExecuteInSessionMode =
          mode ?? (scriptCode && eb.looksLikePuppeteerScript(scriptCode) ? 'puppeteer' : 'dom');

        try {
          const result = await eb.executeInSession({
            env,
            cookies,
            headless: true,
            url,
            waitForSelector,
            script: scriptCode,
            mode: resolvedMode,
            arg,
            dialogPolicy,
            screenshotPath: screenshot,
          });

          if (result.cookies && result.cookies.length > 0) {
            db.updateSessionCookies(session.id, JSON.stringify(result.cookies));
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session: {
                      id: session.id,
                      username: session.username,
                      environment: session.environment,
                      origin: `https://${env}.${eb.baseurl}`,
                      account: session.account,
                    },
                    url: result.url,
                    title: result.title,
                    frameUrl: result.frameUrl,
                    screenshotPath: result.screenshotPath,
                    mode: resolvedMode,
                    dialogs: result.dialogs,
                    result: result.result,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } finally {
          await eb.BrowserManager.getInstance().closeBrowser();
        }
      },
    );

    server.tool(
      'eb_process_inspect',
      "Inspect and project a compact, token-efficient schema of an e-Builder process with local SQLite caching: data fields, layout matrix, and the default workflow as a graph (each step's actors and condition; each action's next step, status, and data field assignments).",
      {
        process: z.string().describe('Name of the Process Type (e.g. "Commitment Change Order")'),
        sessionId: z.number().optional().describe('Session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
        refresh: z
          .boolean()
          .optional()
          .default(false)
          .describe('Force live browser refresh instead of cache'),
      },
      async ({ process: processName, sessionId, username, refresh }) => {
        const session = resolveMcpSession(sessionId, username);
        const { getCachedProcessSchema, fetchProcessSchema } =
          await import('../lib/eb-puppetmaster/process-schema.js');

        if (!refresh) {
          const cached = getCachedProcessSchema(session.environment, session.account, processName);
          if (cached) {
            return {
              content: [{ type: 'text', text: JSON.stringify(cached, null, 2) }],
            };
          }
        }

        const env = eb.getEnvironment(session.environment);
        const cookies = getMcpStoredCookies(session);

        try {
          const schema = await fetchProcessSchema({
            env,
            cookies,
            processName,
            account: session.account,
            useCache: false,
          });

          return {
            content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
          };
        } finally {
          await eb.BrowserManager.getInstance().closeBrowser();
        }
      },
    );

    server.tool(
      'eb_reports_list',
      'List available standard and custom e-Builder reports with category or keyword search and local caching.',
      {
        category: z.string().optional().describe('Filter by category name'),
        search: z.string().optional().describe('Filter by keyword in name or description'),
        sessionId: z.number().optional().describe('Session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
        refresh: z
          .boolean()
          .optional()
          .default(false)
          .describe('Force live refresh of report catalog'),
      },
      async ({ category, search, sessionId, username, refresh }) => {
        const session = resolveMcpSession(sessionId, username);
        const { getCachedReportCatalog, fetchReportCatalog } =
          await import('../lib/eb-puppetmaster/report.js');

        let items = !refresh
          ? getCachedReportCatalog(session.environment, session.account)
          : undefined;
        if (!items) {
          const env = eb.getEnvironment(session.environment);
          const cookies = getMcpStoredCookies(session);
          try {
            items = await fetchReportCatalog({
              env,
              cookies,
              account: session.account,
              useCache: false,
            });
          } finally {
            await eb.BrowserManager.getInstance().closeBrowser();
          }
        }

        if (category) {
          const cat = category.toLowerCase();
          items = items.filter((r) => r.category.toLowerCase().includes(cat));
        }
        if (search) {
          const q = search.toLowerCase();
          items = items.filter(
            (r) =>
              r.name.toLowerCase().includes(q) ||
              (r.description && r.description.toLowerCase().includes(q)),
          );
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
        };
      },
    );

    server.tool(
      'eb_reports_run',
      'Execute an e-Builder report and return token-efficient tabular row data with row limit protection.',
      {
        reportId: z.string().describe('Report ID to execute'),
        limit: z.number().optional().default(50).describe('Max rows to return for token safety'),
        sessionId: z.number().optional().describe('Session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
      },
      async ({ reportId, limit, sessionId, username }) => {
        const session = resolveMcpSession(sessionId, username);
        const env = eb.getEnvironment(session.environment);
        const cookies = getMcpStoredCookies(session);
        const { runReport } = await import('../lib/eb-puppetmaster/report.js');

        try {
          const result = await runReport({
            env,
            cookies,
            reportId,
            limit,
          });

          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } finally {
          await eb.BrowserManager.getInstance().closeBrowser();
        }
      },
    );

    server.tool(
      'eb_reports_export_config',
      'Export portable configuration AST (data source, columns, groupings, filters) of an e-Builder report.',
      {
        reportId: z.string().describe('Report ID to export configuration from'),
        sessionId: z.number().optional().describe('Session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
      },
      async ({ reportId, sessionId, username }) => {
        const session = resolveMcpSession(sessionId, username);
        const env = eb.getEnvironment(session.environment);
        const cookies = getMcpStoredCookies(session);
        const { exportReportConfig } = await import('../lib/eb-puppetmaster/report.js');

        try {
          const config = await exportReportConfig({
            env,
            cookies,
            reportId,
          });

          return {
            content: [{ type: 'text', text: JSON.stringify(config, null, 2) }],
          };
        } finally {
          await eb.BrowserManager.getInstance().closeBrowser();
        }
      },
    );

    server.tool(
      'eb_reports_copy',
      'Copy a report configuration directly from one e-Builder session/account to another.',
      {
        fromSessionId: z.number().describe('Source session ID containing the report to copy'),
        toSessionId: z.number().describe('Target session ID where the report will be recreated'),
        reportId: z.string().describe('Report ID to copy from source session'),
        name: z.string().optional().describe('Optional new name for the recreated report'),
      },
      async ({ fromSessionId, toSessionId, reportId, name }) => {
        const fromSession = db.getSessionById(fromSessionId);
        if (!fromSession) throw new Error(`Source session ${fromSessionId} not found`);
        const toSession = db.getSessionById(toSessionId);
        if (!toSession) throw new Error(`Target session ${toSessionId} not found`);

        const fromEnv = eb.getEnvironment(fromSession.environment);
        const toEnv = eb.getEnvironment(toSession.environment);
        const fromCookies = getMcpStoredCookies(fromSession);
        const toCookies = getMcpStoredCookies(toSession);

        const { exportReportConfig, createReportFromConfig } =
          await import('../lib/eb-puppetmaster/report.js');

        try {
          const config = await exportReportConfig({
            env: fromEnv,
            cookies: fromCookies,
            reportId,
          });

          if (name) {
            config.name = name;
          }

          const result = await createReportFromConfig({
            env: toEnv,
            cookies: toCookies,
            config,
          });

          const payload = {
            success: result.success,
            reportName: config.name,
            reportType: `${config.reportType.text} / ${config.reportSubType.text}`,
            reportId: result.reportId,
            warnings: [...(config.warnings ?? []), ...result.warnings],
            fromSession: { id: fromSession.id, account: fromSession.account },
            toSession: { id: toSession.id, account: toSession.account },
            url: result.url,
          };

          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          };
        } finally {
          await eb.BrowserManager.getInstance().closeBrowser();
        }
      },
    );

    const sessionSchema = {
      sessionId: z.number().optional().describe('Specific session ID to use'),
      username: z.string().optional().describe('Username to resolve session for'),
      account: z
        .string()
        .optional()
        .describe('Select session by account name (substring, e.g. "uat")'),
    };
    const fieldsSchema = z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
      )
      .optional()
      .describe(
        'Fields to set: {"Label": value}. Labels are case-insensitive; DataFieldID GUIDs also work.',
      );
    const instanceSchema = z
      .string()
      .describe('InstanceID GUID, or an open instance name like "RFI - 12" (with project)');
    /** Runs a process-instance operation with the resolved session and returns JSON text. */
    const runProcessTool = async (
      args: {
        sessionId?: number | undefined;
        username?: string | undefined;
        account?: string | undefined;
        project?: string | undefined;
        instance?: string | undefined;
      },
      fn: (ctx: { env: eb.Environment; cookies: any[]; instanceId?: string }) => Promise<unknown>,
    ) => {
      const session = resolveMcpSession(args.sessionId, args.username, args.account);
      const env = eb.getEnvironment(session.environment);
      const cookies = getMcpStoredCookies(session);
      try {
        let instanceId: string | undefined;
        if (args.instance) {
          const { resolveInstanceId } = await import('../lib/process-command-utils.js');
          instanceId = await resolveInstanceId({ env, cookies }, args.instance, args.project);
        }
        const result = await fn({ env, cookies, ...(instanceId ? { instanceId } : {}) });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } finally {
        await eb.BrowserManager.getInstance().closeBrowser();
      }
    };

    server.tool(
      'eb_process_startable',
      'List the processes the user can start (initiate) in a project.',
      { ...sessionSchema, project: z.string().describe('Project name or PortalID') },
      async (a) =>
        runProcessTool(a, (c) => pi.listStartableProcesses({ ...c, project: a.project })),
    );

    server.tool(
      'eb_process_instances',
      "List a project's process instances (open by default; status: closed | draft | all) with name, subject, step, status, dates.",
      {
        ...sessionSchema,
        project: z.string().describe('Project name or PortalID'),
        process: z.string().optional().describe('Filter by process prefix or type'),
        search: z.string().optional().describe('Text filter'),
        status: z
          .enum(['open', 'closed', 'draft', 'all'])
          .optional()
          .default('open')
          .describe('Which instances to list'),
      },
      async (a) =>
        runProcessTool(a, (c) =>
          pi.listProcessInstances({
            ...c,
            project: a.project,
            process: a.process,
            search: a.search,
            status: a.status,
          }),
        ),
    );

    server.tool(
      'eb_process_view',
      'Show a process instance: current step, status, the workflow actions available to the user, ownership state, and every field (label, type, value, editable, options).',
      {
        ...sessionSchema,
        instance: instanceSchema,
        project: z.string().optional().describe('Project (needed when instance is a name)'),
      },
      async (a) =>
        runProcessTool(a, (c) => pi.getProcessInstance({ ...c, instanceId: c.instanceId! })),
    );

    server.tool(
      'eb_process_start',
      'Start (initiate) a process in a project, filling start-form fields, then Submit (or save a draft). Live action: creates a real instance and may notify the next actors.',
      {
        ...sessionSchema,
        project: z.string().describe('Project name or PortalID'),
        process: z.string().describe('Process name, prefix, or ProcessID'),
        subject: z
          .string()
          .optional()
          .describe('Subject (only when the workflow allows a manual subject)'),
        fields: fieldsSchema,
        draft: z
          .boolean()
          .optional()
          .default(false)
          .describe('Save as a draft instead of submitting'),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe('Validate and fill without submitting'),
      },
      async (a) =>
        runProcessTool(a, (c) =>
          pi.startProcessInstance({
            ...c,
            project: a.project,
            process: a.process,
            subject: a.subject,
            fields: a.fields ?? {},
            draft: a.draft,
            dryRun: a.dryRun,
          }),
        ),
    );

    server.tool(
      'eb_process_set_fields',
      'Set fields on a process instance and save (drafts are saved as drafts). Only fields editable at the current step can be set. If ownership of a role-assigned step is pending, pass acceptOwnership: true.',
      {
        ...sessionSchema,
        instance: instanceSchema,
        project: z.string().optional(),
        fields: fieldsSchema,
        acceptOwnership: z.boolean().optional().default(false),
        dryRun: z.boolean().optional().default(false),
      },
      async (a) =>
        runProcessTool(a, (c) =>
          pi.setProcessInstanceFields({
            ...c,
            instanceId: c.instanceId!,
            fields: a.fields ?? {},
            acceptOwnership: a.acceptOwnership,
            dryRun: a.dryRun,
          }),
        ),
    );

    server.tool(
      'eb_process_action',
      'Take a workflow action (e.g. Approve, Revise, Close) on a process instance, optionally with a comment and field updates. Live action: advances the workflow and may notify others. Use eb_process_view to list available actions first.',
      {
        ...sessionSchema,
        instance: instanceSchema,
        project: z.string().optional(),
        action: z.string().describe('Action name (case-insensitive) or action ID'),
        comment: z.string().optional().describe('Comment (required by some actions)'),
        privateComment: z.boolean().optional().default(false),
        fields: fieldsSchema,
        acceptOwnership: z.boolean().optional().default(false),
      },
      async (a) =>
        runProcessTool(a, (c) =>
          pi.takeProcessAction({
            ...c,
            instanceId: c.instanceId!,
            action: a.action,
            comment: a.comment,
            privateComment: a.privateComment,
            fields: a.fields ?? {},
            acceptOwnership: a.acceptOwnership,
          }),
        ),
    );

    server.tool(
      'eb_process_accept_ownership',
      "Accept ownership of an instance's current role-assigned step (the user becomes responsible for completing it).",
      { ...sessionSchema, instance: instanceSchema, project: z.string().optional() },
      async (a) =>
        runProcessTool(a, (c) => pi.acceptProcessOwnership({ ...c, instanceId: c.instanceId! })),
    );

    server.tool(
      'eb_process_submit_draft',
      'Submit a draft process instance (optionally setting fields first).',
      { ...sessionSchema, instance: z.string().describe('Draft InstanceID'), fields: fieldsSchema },
      async (a) =>
        runProcessTool(a, (c) =>
          pi.submitProcessDraft({ ...c, instanceId: c.instanceId!, fields: a.fields ?? {} }),
        ),
    );

    server.tool(
      'eb_agent_guide',
      'Get standard e-Builder URL routing rules, in-browser eb helper documentation, and safety best practices.',
      {},
      async () => {
        const guide = {
          standardPaths: STANDARD_PATHS,
          scriptSyntax: {
            dom: '(arg, eb) => ... or a bare expression',
            puppeteer:
              'async ({ page, browser, context, env, origin, url, arg, args, fs, path, os, eb, settle, inspect }) => ... (no export default / module.exports needed)',
          },
          browserHelperMethods: {
            'eb.getContentDocument()': 'Returns #contentFrame document or top document',
            'eb.findField(nameOrLabel)': 'Locates input/select/textarea by ID, name, or label text',
            'eb.getRadComboBox(idOrName)': 'Extracts { id, text, value, options } for RadComboBox',
            'eb.setRadComboBox(idOrName, valueOrText)':
              'Selects RadComboBox item and fires change events',
            'eb.getTable(selectorOrId, maxRows)': 'Scrapes table into { headers, rowCount, rows }',
            'eb.buildFormParams(formOrSelector?, overrides?, eventTarget?, eventArg?)':
              'Serializes ASP.NET form (__VIEWSTATE etc.) to URLSearchParams',
            'eb.postWebForm(url?, formOrSelector?, overrides?, eventTarget?, eventArg?)':
              'fetch() postback resolving { url, status, html }',
            'eb.getWorkflowData(processId, workflowId, version?)':
              'Returns { xml: "<ebWorkflow>…", isActive } (version 3 = published, 1 = draft)',
            'eb.getLayoutXml(processId, layoutId)': 'Returns page layout <ebLayout> XML',
            'eb.exportReportCsv(reportId)': 'Returns full custom report CSV',
          },
          errorCodes: {
            SessionExpiredError: 'Redirected to login: user must re-authenticate.',
            NetworkError: 'e-Builder unreachable (often a sandbox). Session is still valid.',
            NavigationTimeoutError: 'Timed out. Retry; session still valid.',
            ServerError: 'HTTP 5xx. Retry later; session still valid.',
          },
          safetyGuardrails: [
            'Read-only by default in live environments.',
            'Never click Submit or advance workflow steps without explicit user consent.',
            'Inspect pages before attempting mutations.',
          ],
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(guide, null, 2) }],
        };
      },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

function resolveMcpSession(sessionId?: number, username?: string, account?: string): db.SessionRow {
  if (sessionId) {
    const s = db.getSessionById(sessionId) as db.SessionRow;
    if (!s) throw new Error(`Session with ID ${sessionId} not found.`);
    return s;
  }
  let sessions = (
    username ? db.getSessionsByUsername(username) : db.getSessions()
  ) as db.SessionRow[];
  if (username && sessions.length === 0)
    throw new Error(`No sessions found for username ${username}.`);
  if (sessions.length === 0) {
    throw new Error(
      "No active e-Builder sessions found in eb-cli. Please run 'eb session import' or 'eb login' first.",
    );
  }
  if (account) {
    const needle = account.trim().toLowerCase();
    const exact = sessions.filter((s) => (s.account ?? '').trim().toLowerCase() === needle);
    const partial = sessions.filter((s) => (s.account ?? '').toLowerCase().includes(needle));
    const matches = exact.length > 0 ? exact : partial;
    if (matches.length === 0) {
      throw new Error(
        `No sessions found matching account "${account}". Available: ${sessions
          .map((s) => `"${s.account}" (id ${s.id})`)
          .join(', ')}.`,
      );
    }
    sessions = matches;
  }
  return [...sessions].sort((a, b) => b.id - a.id)[0]!;
}

/** Stored cookies without a pre-flight check; executeInSession verifies auth on navigation. */
function getMcpStoredCookies(session: db.SessionRow): any[] {
  return JSON.parse(session.session_cookies || '[]');
}
