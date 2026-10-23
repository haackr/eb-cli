import { Command, Flags } from '@oclif/core';

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
      version: '1.0.0',
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
            'Evaluates JavaScript in the browser DOM context. Automatically unwraps #contentFrame and injects the global "eb" helper.',
          example:
            'eb session exec /da2/Processes/StartProcess.aspx --eval "(arg, eb) => eb.findField(\'Title\')?.value" --json',
        },
        puppeteerEvaluation: {
          command:
            'eb session exec <relative-path> --puppeteer --script-file <path.js> --arg \'{"key":"val"}\' --json',
          description:
            'Evaluates multi-step Puppeteer scripts in Node context with access to { page, browser, context, env, origin, url, arg, settle, inspect }.',
        },
      },
      browserHelperApi: {
        'eb.getContentDocument()':
          'Returns iframe#contentFrame document if present, otherwise returns top-level document.',
        'eb.findField(nameOrLabel)':
          'Locates an input, select, or textarea by ID, name attribute, or associated <label> text (case-insensitive fuzzy match).',
        'eb.getRadComboBox(idOrName)':
          'Retrieves Telerik RadComboBox details: { id, text, value, options: string[] }.',
        'eb.setRadComboBox(idOrName, valueOrText)':
          'Selects an option in a Telerik RadComboBox by text or value and triggers change events.',
        'eb.getTable(selectorOrId, maxRows)':
          'Parses a table (e.g. RadGrid) into { headers: string[], rowCount: number, rows: Record<string, string>[] }.',
      },
      standardPaths: {
        home: '/da2/Home/index2.aspx',
        processesView: '/da2/Processes/ProcessesView.aspx',
        processTypesView: '/da2/Setup/Processes/ProcessTypesView.aspx',
        importProcesses: '/da2/Processes/ImportProcesses/ImportProcesses.aspx',
        manageUsers: '/da2/Users/ManageUsers.aspx',
        apiLogs: '/da2/ApiLogs/ApiLogs.aspx',
      },
      safetyRules: [
        'Never submit live workflow forms or click destructive buttons without explicit user consent.',
        'Always test session health first with "eb session test --no-delete --json" or list sessions with "eb session list --json".',
        'Use relative e-Builder paths (/da2/...) so the CLI automatically rewrites hostnames to the session environment origin.',
      ],
    };

    if (this.jsonEnabled()) {
      return guideData;
    }

    const markdownText = `# Trimble e-Builder AI Agent Automation Guide

## 1. Quick Start for AI Agents

When interacting with e-Builder, execute commands with the \`--json\` flag. The CLI operates non-interactively:
- Auto-selects active authenticated sessions without TTY prompt deadlocks.
- Catches errors and returns structured JSON diagnostics with failure screenshots.

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

## 2. In-Browser "eb" Helper Reference

| Method | Description |
| :--- | :--- |
| \`eb.getContentDocument()\` | Returns \`contentFrame.contentDocument\` if present, else \`document\`. |
| \`eb.findField(nameOrLabel)\` | Fuzzy-matches inputs, selects, or textareas by ID, name, or label text. |
| \`eb.getRadComboBox(idOrName)\` | Returns \`{ id, text, value, options }\` for Telerik RadComboBox. |
| \`eb.setRadComboBox(idOrName, val)\` | Selects RadComboBox option and triggers ASP.NET events. |
| \`eb.getTable(selector, maxRows)\` | Scrapes tables (including RadGrid) into clean JSON records. |

## 3. Standard e-Builder Paths
- **Home**: \`/da2/Home/index2.aspx\`
- **Processes List**: \`/da2/Processes/ProcessesView.aspx\`
- **Process Types Setup**: \`/da2/Setup/Processes/ProcessTypesView.aspx\`
- **Process Import Wizard**: \`/da2/Processes/ImportProcesses/ImportProcesses.aspx\`
- **User Management**: \`/da2/Users/ManageUsers.aspx\`

## 4. MCP Server
For Model Context Protocol (MCP) clients, run:
\`\`\`bash
eb mcp
\`\`\`
`;

    this.log(markdownText);
    return guideData;
  }
}
