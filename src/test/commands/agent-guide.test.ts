import { describe, it } from 'node:test';
import assert from 'node:assert';
import AgentGuide from '../../commands/agent/guide.js';

describe('Agent Guide Command (src/commands/agent/guide.ts)', () => {
  it('outputs structured JSON guide when --json is passed', async () => {
    const result: any = await AgentGuide.run(['--json']);

    assert.ok(result);
    assert.strictEqual(result.name, 'eb-cli-agent-guide');
    assert.ok(result.workflows.pageInspection);
    assert.ok(result.browserHelperApi['eb.findField(nameOrLabel)']);
    assert.strictEqual(result.standardPaths.home, '/da2/Home/index2.aspx');
    assert.strictEqual(result.standardPaths.reportsList, '/da2/Reports/index.aspx');
    assert.ok(!JSON.stringify(result.standardPaths).includes('ProcessTypesView'));
    assert.ok(result.errorCodes.NetworkError);
    assert.ok(result.browserHelperApi['eb.exportReportCsv(reportId)']);
    assert.ok(result.browserHelperApi['eb.getWorkflowData(processId, workflowId, version?)']);
    assert.ok(result.browserHelperApi['eb.getLayoutXml(processId, layoutId)']);
    assert.ok(!JSON.stringify(result).includes('DownloadWorkflowHandler'));
    assert.match(result.standardPaths.workflowDataRpc, /\/da2\/Processes\/ProcessesService\.asmx/);
    assert.match(result.workflows.puppeteerEvaluation.description, /async \(\{ page/);
    assert.match(result.workflows.sessionSelection.description, /--account/);
    assert.match(result.version, /^1\.2\./);
    assert.match(
      result.workflows.processSchema.output.actionDetails,
      /next step.*assignments/,
      'process schema section describes transitions and field assignments',
    );
  });

  it('documents every eb command', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const commandsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../commands',
    );
    const commandIds = (fs.readdirSync(commandsDir, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.replace(/\.js$/, '').split(path.sep).join(' '))
      .filter((id) => id !== 'agent guide');
    const guide = JSON.stringify(await AgentGuide.run(['--json']));
    const missing = commandIds.filter((id) => !guide.includes(`eb ${id}`));
    assert.deepStrictEqual(
      missing,
      [],
      `commands missing from the agent guide: ${missing.join(', ')}`,
    );
  });

  it('outputs formatted markdown guide without --json', async () => {
    let logged = '';
    const originalLog = console.log;
    console.log = (msg: string) => {
      logged += msg;
    };

    try {
      await AgentGuide.run([]);
    } finally {
      console.log = originalLog;
    }

    assert.ok(logged.includes('# Trimble e-Builder AI Agent Automation Guide'));
    assert.ok(logged.includes('eb session exec <relative-path> --inspect --json'));
    assert.ok(logged.includes('| `eb.getTable(selectorOrId, maxRows)` |'));
    assert.ok(!logged.includes('\\`'));
  });
});
