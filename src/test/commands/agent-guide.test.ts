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
    assert.match(result.workflows.puppeteerEvaluation.description, /async \(\{ page/);
    assert.match(result.workflows.sessionSelection.description, /--account/);
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
