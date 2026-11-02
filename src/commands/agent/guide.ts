import { Command, Flags } from '@oclif/core';

/** e-Builder paths observed working in US3 production sessions. */
export const STANDARD_PATHS = {
  home: '/da2/Home/index2.aspx',
  processesView: '/da2/Processes/ProcessesView.aspx',
  manageProcesses: '/da2/Setup/Admin/Processes/ManageProcesses.aspx',
  viewProcess: '/da2/Setup/Admin/Processes/ViewProcess.aspx?ProcessID={GUID}',
  downloadWorkflow:
    '/da2/Setup/Admin/Processes/Workflows/DownloadWorkflowHandler.ashx?WorkflowID={GUID}',
  fieldDependenciesRpc:
    'POST /da2/Controls/AjaxService.asmx/FieldDependenciesGetAllDependencies { processID }',
  importProcesses: '/da2/Processes/ImportProcesses/ImportProcesses.aspx',
  reportsList: '/da2/Reports/index.aspx',
  editReport: '/da2/Reports/AddEditReport.aspx?ReportID={GUID}',
  reportResults: '/da2/Reports/ReportResults.aspx?ReportID={GUID}',
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
          example: 'eb session exec /da2/Processes/ProcessesView.aspx --inspect --json',
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
        'eb.downloadWorkflowXml(workflowId)':
          'Returns the .ebw workflow XML for a WorkflowID GUID.',
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
eb session exec --account prod --url /da2/Processes/ProcessesView.aspx --file script.js --json
\`\`\`
Puppeteer mode is auto-detected; \`--puppeteer\` / \`--no-puppeteer\` force it. Dialogs are dismissed by default (\`--dialog-policy accept|dismiss|manual\`).

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
