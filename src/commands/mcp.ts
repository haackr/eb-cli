import { Command } from '@oclif/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as eb from '../lib/eb-puppetmaster/index.js';
import * as db from '../lib/db.js';
import { refreshSessionIfNeeded } from '../lib/login-helper.js';

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
          .describe('Whether to delete invalid sessions (defaults to false)'),
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
          try {
            const { isLoggedIn, newCookies } = await eb.isLoggedIn(env, true, cookies);
            if (isLoggedIn) {
              db.updateSessionById(
                session.id,
                session.username,
                session.environment,
                session.account,
                JSON.stringify(newCookies),
              );
              results.push({
                id: session.id,
                username: session.username,
                environment: session.environment,
                account: session.account,
                valid: true,
                refreshed: true,
                deleted: false,
              });
            } else {
              if (deleteInvalid) {
                db.deleteSessionById(session.id);
              }
              results.push({
                id: session.id,
                username: session.username,
                environment: session.environment,
                account: session.account,
                valid: false,
                refreshed: false,
                deleted: Boolean(deleteInvalid),
                error: 'Session invalid or cookies expired',
              });
            }
          } catch (err: any) {
            results.push({
              id: session.id,
              username: session.username,
              environment: session.environment,
              account: session.account,
              valid: false,
              refreshed: false,
              deleted: false,
              error: err.message,
            });
          }
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
          .describe('e-Builder relative path (e.g. /da2/Processes/ProcessesView.aspx) or full URL'),
        sessionId: z.number().optional().describe('Specific session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
        waitForSelector: z
          .string()
          .optional()
          .describe('CSS selector to wait for before inspecting'),
        screenshot: z.boolean().optional().describe('Capture screenshot to temporary file'),
      },
      async ({ url, sessionId, username, waitForSelector, screenshot }) => {
        const session = resolveMcpSession(sessionId, username);
        const env = eb.getEnvironment(session.environment);
        const cookies = await getMcpSessionCookies(session);

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
        eval: z.string().optional().describe('JavaScript snippet to evaluate'),
        mode: z.enum(['dom', 'puppeteer']).optional().default('dom').describe('Execution mode'),
        arg: z.unknown().optional().describe('Argument passed to the script function'),
        waitForSelector: z.string().optional().describe('CSS selector to wait for'),
        sessionId: z.number().optional().describe('Specific session ID to use'),
        username: z.string().optional().describe('Username to resolve session for'),
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
        screenshot,
      }) => {
        const session = resolveMcpSession(sessionId, username);
        const env = eb.getEnvironment(session.environment);
        const cookies = await getMcpSessionCookies(session);

        try {
          const result = await eb.executeInSession({
            env,
            cookies,
            headless: true,
            url,
            waitForSelector,
            script: scriptCode,
            mode,
            arg,
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
      'Inspect and project a compact, token-efficient schema of an e-Builder process (fields, workflow steps, layout matrix) with local SQLite caching.',
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
        const cookies = await getMcpSessionCookies(session);

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
          const cookies = await getMcpSessionCookies(session);
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
        const cookies = await getMcpSessionCookies(session);
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
        const cookies = await getMcpSessionCookies(session);
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
        const fromCookies = await getMcpSessionCookies(fromSession);
        const toCookies = await getMcpSessionCookies(toSession);

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
            dataSource: config.dataSource,
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

    server.tool(
      'eb_agent_guide',
      'Get standard e-Builder URL routing rules, in-browser eb helper documentation, and safety best practices.',
      {},
      async () => {
        const guide = {
          standardPaths: {
            home: '/da2/Home/index2.aspx',
            processesView: '/da2/Processes/ProcessesView.aspx',
            processTypesView: '/da2/Setup/Processes/ProcessTypesView.aspx',
            importProcesses: '/da2/Processes/ImportProcesses/ImportProcesses.aspx',
            manageUsers: '/da2/Users/ManageUsers.aspx',
            apiLogs: '/da2/ApiLogs/ApiLogs.aspx',
          },
          browserHelperMethods: {
            'eb.getContentDocument()': 'Returns #contentFrame document or top document',
            'eb.findField(nameOrLabel)': 'Locates input/select/textarea by ID, name, or label text',
            'eb.getRadComboBox(idOrName)': 'Extracts { id, text, value, options } for RadComboBox',
            'eb.setRadComboBox(idOrName, valueOrText)':
              'Selects RadComboBox item and fires change events',
            'eb.getTable(selectorOrId, maxRows)': 'Scrapes table into { headers, rowCount, rows }',
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

function resolveMcpSession(sessionId?: number, username?: string): db.SessionRow {
  if (sessionId) {
    const s = db.getSessionById(sessionId) as db.SessionRow;
    if (!s) throw new Error(`Session with ID ${sessionId} not found.`);
    return s;
  }
  if (username) {
    const sessions = db.getSessionsByUsername(username) as db.SessionRow[];
    if (sessions.length === 0) throw new Error(`No sessions found for username ${username}.`);
    return [...sessions].sort((a, b) => b.id - a.id)[0]!;
  }
  const allSessions = db.getSessions() as db.SessionRow[];
  if (allSessions.length === 0) {
    throw new Error(
      "No active e-Builder sessions found in eb-cli. Please run 'eb session import' or 'eb login' first.",
    );
  }
  return [...allSessions].sort((a, b) => b.id - a.id)[0]!;
}

async function getMcpSessionCookies(session: db.SessionRow): Promise<any[]> {
  const refreshed = await refreshSessionIfNeeded(session.id, true);
  if (!refreshed) {
    throw new Error(
      `Session ${session.id} (${session.username}) has expired. Please re-authenticate using 'eb login' or 'eb session import'.`,
    );
  }
  const updated = db.getSessionById(session.id) as db.SessionRow;
  return JSON.parse(updated.session_cookies);
}
