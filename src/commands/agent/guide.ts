import { Command, Flags } from '@oclif/core';

/**
 * e-Builder paths (relative; the CLI resolves the host from the session's environment).
 * Verified against a live US1 session on 2026-11-02. There is no workflow download handler
 * (DownloadWorkflowHandler.ashx returns 404); use eb.getWorkflowData instead.
 */
export const STANDARD_PATHS = {
  home: '/da2/Home/index2.aspx',
  processesMain: '/da2/Processes/ProcessesMain.aspx (In My Court / Initiated by Me)',
  projectProcesses: '/da2/Processes/ProjectProcesses.aspx?PortalID={GUID}',
  startProcess: '/da2/Processes/StartProcess.aspx?PortalID={GUID}&ProcessID={GUID}',
  instanceDetails: '/da2/Processes/InstanceDetails.aspx?InstanceID={GUID}',
  manageProcesses: '/da2/Setup/Admin/Processes/ManageProcesses.aspx',
  viewProcess: '/da2/Setup/Admin/Processes/ViewProcess.aspx?ProcessID={GUID}',
  manageDataFields: '/da2/Setup/Admin/Processes/ManageDataFields.aspx?ProcessID={GUID}',
  manageLayouts: '/da2/Setup/Admin/Processes/ManageLayouts.aspx?ProcessID={GUID}',
  viewLayout: '/da2/Setup/Admin/Processes/ViewLayout.aspx?LayoutID={GUID}&ProcessID={GUID}',
  layoutXml:
    'GET /da2/Setup/Admin/Processes/AddEditLayout.aspx?ajaxRefresh=1&LayoutID=<guid>&ProcessID=<guid>&defSecID=&moduleSecID=&mode= (use eb.getLayoutXml)',
  manageWorkflows: '/da2/Setup/Admin/Processes/ManageWorkflows.aspx?ProcessID={GUID}',
  viewWorkflow: '/da2/Setup/Admin/Processes/ViewWorkflow.aspx?WorkflowID={GUID}&ProcessID={GUID}',
  workflowDesigner:
    '/da2/Setup/Admin/Processes/WorkflowDesigner.aspx?WorkflowID={GUID}&ProcessID={GUID}&mode=0 (exposes securityToken)',
  workflowDataRpc:
    'POST /da2/Processes/ProcessesService.asmx/GetWorkflowData { securityToken, processID, workflowID, version } (use eb.getWorkflowData)',
  importProcesses: '/da2/Processes/ImportProcesses/ImportProcesses.aspx',
  reportsList: '/da2/Reports/index.aspx',
  editReport: '/da2/Reports/AddEditReport.aspx?ReportID={GUID}',
  reportResults: '/da2/Reports/ReportResults.aspx?ReportID={GUID}',
  biReport: '/da2/Reports/BusinessIntelligence/BIReports.aspx?ActionType=2&ReportID={GUID}',
  manageUsers: '/da2/Users/ManageUsers.aspx',
  apiLogs: '/da2/ApiLogs/ApiLogs.aspx',
} as const;

export default class AgentGuide extends Command {
  static override description =
    'output system prompt instructions, DOM helper API, and e-Builder execution recipes for AI agents';
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];
  static override enableJsonFlag = true;
  static override aliases: string[] = ['agent:guide', 'agent-guide'];

  static override flags = {
    markdown: Flags.boolean({
      description: 'output guide as formatted Markdown',
      default: true,
    }),
  };

  public async run(): Promise<unknown> {
    await this.parse(AgentGuide);

    const guideData = {
      name: 'eb-cli-agent-guide',
      version: '1.1.0',
      description:
        'Official operational manual for AI agents automating Trimble e-Builder via eb-cli',
      workflows: {
        pageInspection: {
          command: 'eb session exec <relative-path> --inspect --json',
          description:
            'Extracts a clean, token-efficient JSON AST of all form inputs, RadComboBoxes, buttons, tables, alerts, and breadcrumbs. Always run this before submitting forms or mutating state.',
          example: 'eb session exec /da2/Processes/ProcessesMain.aspx --inspect --json',
        },
        domEvaluation: {
          command: 'eb session exec <relative-path> --eval "<code>" --json',
          description:
            'Evaluates JavaScript in the browser DOM context. Write a bare expression or `(arg, eb) => ...`. Automatically unwraps #contentFrame and injects the global "eb" helper.',
          example:
            'eb session exec /da2/Processes/StartProcess.aspx --eval "(arg, eb) => eb.findField(\'Title\')?.value" --json',
        },
        puppeteerEvaluation: {
          command:
            'eb session exec --url <relative-path> --file <path.js> --arg \'{"key":"val"}\' --json',
          description:
            'Runs multi-step Puppeteer scripts in Node. Write a bare function: `async ({ page, browser, context, env, origin, url, arg, args, fs, path, os, eb, settle, inspect }) => { ... }`. No `export default` / `module.exports` needed (they are tolerated). Puppeteer mode is auto-detected from `({ page })` / `page.*`; pass --puppeteer or --no-puppeteer to force.',
        },
        sessionSelection: {
          description:
            'Select a session by account name rather than numeric ID: --account prod, --account uat, or -A "Acme - Production" (case-insensitive substring). --session-id <n> and --username <u> also work. With none, the newest session is used non-interactively.',
          example: 'eb session exec --account uat ./script.js --json',
        },
        processUse: {
          description:
            'Start processes, take workflow actions, and set fields with dedicated commands (no scripting needed). All accept --json; instances can be given by InstanceID or by name ("RFI - 12") with --project.',
          commands: {
            'eb process startable -P <project>': 'Processes the user can start in the project.',
            'eb process instances -P <project> [--process RFI] [--search text]':
              'Open instances with step/status.',
            'eb process view <instance> [-P <project>]':
              'Current step, status, available actions, ownership state, and every field (label, type, value, editable, options).',
            'eb process start <process> -P <project> [--subject s] -F "Label=value" ... [--draft] [--dry-run]':
              'Initiate a process. Some workflows generate the subject; omit --subject for those.',
            'eb process set <instance> -F "Label=value" ... [--accept-ownership] [--dry-run]':
              'Edit fields and save.',
            'eb process action <instance> --action <name> [--comment c] [-F ...]':
              'Take a workflow action. Some actions require --comment.',
            'eb process accept <instance>': 'Accept ownership of a role-assigned step.',
            'eb process submit <draft-id> [-F ...]': 'Submit a draft.',
          },
          rules: [
            'Always `eb process view` first: it lists the exact action names and which fields are editable at this step.',
            'start and action are live: they create/advance real instances and can notify other users. Use --dry-run (start/set) to validate first.',
            'If a step is assigned to a role and nobody accepted it, e-Builder silently discards field edits; the CLI refuses unless --accept-ownership is passed. Only accept when the user intends to take responsibility for the step.',
            'Never retry `process start` after an ambiguous error without checking `eb process instances` first (avoid duplicates).',
          ],
        },
        browserDaemon: {
          description:
            'Before running many eb commands in a row, run "eb daemon start" to reuse one warm headless browser (each command still gets an isolated context; it exits after 15 idle minutes). "eb daemon stop" ends it.',
          sandboxes:
            "If your tool runner kills child processes when each command finishes, start the daemon with the runner's background/daemon option so the browser survives between commands; otherwise it is reaped immediately and every command falls back to launching its own browser.",
        },
        dialogs: {
          description:
            'alert/confirm/prompt are dismissed by default and listed in the `dialogs` output. Use --dialog-policy accept to confirm (e.g. delete/void actions), or register page.on("dialog") in a Puppeteer script to handle them yourself.',
        },
      },
      errorCodes: {
        SessionExpiredError:
          'e-Builder redirected to a login page. The user must re-authenticate (eb login / eb session import).',
        NetworkError:
          'e-Builder was unreachable (DNS/connection). Usually a sandbox without network access: re-run with network access. Session is still valid; do NOT ask the user to log in.',
        NavigationTimeoutError: 'Page load timed out. Retry; the session was not invalidated.',
        ServerError: 'e-Builder returned HTTP 5xx. Retry later; the session was not invalidated.',
      },
      browserHelperApi: {
        'eb.getContentDocument()':
          'Returns the iframe#contentFrame document when present and loaded, otherwise the top-level document.',
        'eb.findField(nameOrLabel)':
          'Locates an input, select, or textarea by ID, name attribute, or associated <label> text (case-insensitive fuzzy match).',
        'eb.getRadComboBox(idOrName)':
          'Retrieves Telerik RadComboBox details: { id, text, value, options: string[] }.',
        'eb.setRadComboBox(idOrName, valueOrText)':
          'Selects an option in a Telerik RadComboBox by text or value and triggers change events.',
        'eb.getTable(selectorOrId, maxRows)':
          'Parses a table (e.g. RadGrid) into { headers: string[], rowCount: number, rows: Record<string, string>[] }.',
        'eb.buildFormParams(formOrSelector?, overrides?, eventTarget?, eventArg?)':
          'Serializes the ASP.NET form (__VIEWSTATE, __EVENTVALIDATION, inputs) into URLSearchParams. Overrides accept short control names (btnSave) or full names; null removes a field.',
        'eb.postWebForm(url?, formOrSelector?, overrides?, eventTarget?, eventArg?)':
          'POSTs the form via fetch() and resolves { url, status, html, doc } (doc omitted in Puppeteer mode).',
        'eb.getWorkflowData(processId, workflowId, version?)':
          'Returns { xml: "<ebWorkflow>…", isActive } via the workflow designer token + ProcessesService.GetWorkflowData. version: 3 = published (default), 1 = saved draft. GUIDs with or without braces.',
        'eb.getLayoutXml(processId, layoutId)':
          'Returns the page layout definition XML (<ebLayout>).',
        'eb.exportReportCsv(reportId)': 'Runs a custom report and returns the full CSV export.',
      },
      standardPaths: STANDARD_PATHS,
      safetyRules: [
        'Never submit live workflow forms or click destructive buttons without explicit user consent.',
        'Check session health with "eb session test --json" (it never deletes sessions unless --delete is passed) or list sessions with "eb session list --json".',
        'Treat only SessionExpiredError as a logged-out session. NetworkError / NavigationTimeoutError / ServerError mean the session is fine.',
        'Use relative e-Builder paths (/da2/...) so the CLI automatically rewrites hostnames to the session environment origin.',
      ],
    };

    if (this.jsonEnabled()) {
      return guideData;
    }

    const markdownText = `# Trimble e-Builder AI Agent Automation Guide

## 1. Quick Start for AI Agents

When interacting with e-Builder, execute commands with the \`--json\` flag. The CLI operates non-interactively:
- Auto-selects the newest session, or target one with \`--account prod\` / \`--account uat\` / \`--session-id <n>\`.
- Catches errors and returns structured JSON diagnostics (typed \`error.code\`) with failure screenshots.

### Step 1: Discover Page Structure (Sensory Step)
Before attempting any interaction, inspect the target page:
\`\`\`bash
eb session exec <relative-path> --inspect --json
\`\`\`
Returns an AST of all inputs, RadComboBoxes, buttons, tables, and system alerts without dumping raw ASP.NET HTML.

### Step 2: Query or Interact using In-Browser "eb" Helper
Inside \`--eval\` scripts, the global \`eb\` helper automatically handles \`iframe#contentFrame\` and RadControls:
\`\`\`bash
eb session exec /da2/Processes/StartProcess.aspx --eval "(arg, eb) => {
  const title = eb.findField('Project Name');
  const vendor = eb.getRadComboBox('Vendor');
  return { title: title?.value, vendor };
}" --json
\`\`\`

### Step 3: Multi-step Puppeteer Scripts
Write a **bare function** (no \`export default\` / \`module.exports\` needed) and pass it with \`--file\`:
\`\`\`js
// script.js
async ({ page, arg, eb, fs }) => {
  await page.click('#ctl00_btnSearch');
  return await eb.getTable('table.rgMasterTable', 100);
}
\`\`\`
\`\`\`bash
eb session exec --account prod --url /da2/Processes/ProcessesMain.aspx --file script.js --json
\`\`\`
Puppeteer mode is auto-detected; \`--puppeteer\` / \`--no-puppeteer\` force it. Dialogs are dismissed by default (\`--dialog-policy accept|dismiss|manual\`).

For loops of many commands, run \`eb daemon start\` first to reuse a warm headless browser. If your tool runner kills child processes after each command, launch it with the runner's background/daemon option so it persists.

### Working with processes (start, act, set fields)
\`\`\`bash
eb process startable -P "Project X" --json                      # what can be started here
eb process start RFI -P "Project X" -F "Question=Door spec?" --json
eb process instances -P "Project X" --process RFI --json        # open instances
eb process view "RFI - 12" -P "Project X" --json                 # actions + editable fields
eb process set "RFI - 12" -P "Project X" -F "Drawing Number=A-101" --json
eb process action "RFI - 12" -P "Project X" --action Revise --comment "Need drawing" --json
\`\`\`
Starting and acting are live operations that notify other users. View the instance first to get exact action names and editable fields. If a role-assigned step has not been accepted, field edits need \`--accept-ownership\`.

## 2. In-Browser "eb" Helper Reference

| Method | Description |
| :--- | :--- |
${Object.entries(guideData.browserHelperApi)
  .map(([k, v]) => `| \`${k}\` | ${v} |`)
  .join('\n')}

## 3. Error Codes

${Object.entries(guideData.errorCodes)
  .map(([k, v]) => `- **${k}**: ${v}`)
  .join('\n')}

## 4. Standard e-Builder Paths
${Object.entries(STANDARD_PATHS)
  .map(([k, v]) => `- **${k}**: \`${v}\``)
  .join('\n')}

## 5. Sessions
- \`eb session list --json\`: list stored sessions (id, username, environment, account).
- \`eb session test --json\`: verify and refresh sessions. Reports \`reason\`; never deletes unless \`--delete\` is passed, and then only sessions redirected to login.

## 6. MCP Server
For Model Context Protocol (MCP) clients, run:
\`\`\`bash
eb mcp
\`\`\`
`;

    this.log(markdownText);
    return guideData;
  }
}
