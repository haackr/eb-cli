import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import { Environment } from '../../lib/eb-puppetmaster/index.js';
import {
  assertReportConfig,
  createReportFromConfig,
  exportReportConfig,
  fetchReportCatalog,
  runReport,
  type ReportConfig,
} from '../../lib/eb-puppetmaster/report.js';
import {
  compactProcessSchema,
  fetchProcessSchema,
  PROCESS_SCHEMA_VERSION,
} from '../../lib/eb-puppetmaster/process-schema.js';
import { processSchemaToMarkdown } from '../../lib/eb-puppetmaster/process-schema-doc.js';
import { MockEBuilder } from './mock-ebuilder.js';

const tabular: ReportConfig = {
  version: 2,
  name: 'RH tabular',
  description: 'test report',
  access: 'Personal',
  reportType: { value: '3', text: 'Cost Reports' },
  reportSubType: { value: '7', text: 'Commitments' },
  style: { value: '1', text: 'Tabular' },
  expandMultiValuedFields: false,
  columns: [
    { group: 'ProjectInformation', label: 'Project Name' },
    { group: 'ProjectInformation', label: 'Project Status' },
    { group: 'CostSummary', label: 'Current Budget' },
  ],
  // Differs from the order the columns are checked in, so the reorder postbacks run.
  columnOrder: [
    { key: 'CostSummary.CurrentBudget', label: 'Current Budget' },
    { key: '', label: 'Project Name' },
    { key: 'PortalStatus.StatusID', label: 'Project Status' },
  ],
  aggregates: [{ column: 'Current Budget', functions: ['Sum'] }],
  sorts: [{ key: 'Portals.Name', label: 'Project Name', direction: 'DESC' }],
  requireProjectSelection: true,
  filters: [
    {
      field: { value: 'Portals.Name', text: 'Project Name' },
      operator: { value: '9', text: 'starts with' },
      value: 'RH',
    },
  ],
};

describe('Report wizard driver against a mock e-Builder (report.ts / report-wizard.ts)', () => {
  let mock: MockEBuilder;
  let browser: puppeteer.Browser;
  const base = () => ({ env: Environment.US2, cookies: [], browser, origin: mock.origin });

  before(async () => {
    mock = new MockEBuilder();
    await mock.start();
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  });

  after(async () => {
    await browser?.close();
    await mock.stop();
  });

  it('creates a report from a config, applying every wizard step', async () => {
    // Leave stale wizard state behind, like a previous session would.
    mock.state.columns.add('ProjectInformation|Create Date');

    const result = await createReportFromConfig({ ...base(), config: tabular });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.warnings, []);
    const saved = mock.reports.find((r) => r.id === result.reportId);
    assert.ok(saved, 'report saved');
    assert.strictEqual(saved.name, 'RH tabular');
    assert.strictEqual(saved.access, 'Personal');
    assert.strictEqual(saved.def.sub, '7');
    assert.deepStrictEqual(saved.def.order, [
      'CostSummary.CurrentBudget',
      'Portals.Name',
      'PortalStatus.StatusID',
    ]);
    assert.ok(!saved.def.columns.has('ProjectInformation|Create Date'), 'stale column cleared');
    assert.deepStrictEqual([...saved.def.aggs], ['Current Budget']);
    assert.deepStrictEqual(saved.def.sorts, [{ key: 'Portals.Name', dir: '1' }]);
    assert.strictEqual(saved.def.requireProject, true);
    assert.deepStrictEqual(saved.def.filters, [{ field: 'Portals.Name', op: '9', value: 'RH' }]);
  });

  it('round-trips the report through export-config', async () => {
    const id = mock.reports[0]!.id;
    const exported = await exportReportConfig({ ...base(), reportId: `{${id.toUpperCase()}}` });
    assert.strictEqual(exported.version, 2);
    assert.strictEqual(exported.name, 'RH tabular');
    assert.strictEqual(exported.description, 'test report');
    assert.strictEqual(exported.access, 'Personal');
    assert.strictEqual(exported.folder, undefined);
    assert.deepStrictEqual(exported.reportType, tabular.reportType);
    assert.deepStrictEqual(exported.reportSubType, tabular.reportSubType);
    assert.deepStrictEqual(exported.style, { value: '1', text: 'Tabular' });
    assert.deepStrictEqual(exported.columns, tabular.columns);
    assert.deepStrictEqual(
      exported.columnOrder.map((c) => c.key),
      ['CostSummary.CurrentBudget', 'Portals.Name', 'PortalStatus.StatusID'],
    );
    assert.deepStrictEqual(exported.aggregates, tabular.aggregates);
    assert.deepStrictEqual(exported.sorts, tabular.sorts);
    assert.deepStrictEqual(exported.filters, tabular.filters);
    assert.strictEqual(exported.requireProjectSelection, true);
  });

  it('starts new reports via Add Report so a session bound to a saved report can Save As', async () => {
    // The previous test left the session bound to a saved report (as e-Builder does).
    const before = mock.saveErrors;
    const copy = { ...tabular, name: 'RH tabular (copy)' };
    const result = await createReportFromConfig({ ...base(), config: copy });
    assert.ok(result.reportId);
    assert.strictEqual(mock.saveErrors, before);
  });

  it('handles Summary style groupings, shared folders, and relative date filters', async () => {
    const summary: ReportConfig = {
      ...tabular,
      name: 'RH summary',
      access: 'AllUsers',
      folder: 'Budget Reports',
      style: { value: '2', text: 'Summary' },
      groupings: [
        { key: 'Portals.Name', label: 'Project Name', sortOrder: 'Desc', dateGrouping: 'Day' },
      ],
      dateFilter: {
        column: { value: 'Portals.CreateDate', text: 'Create Date' },
        duration: { value: '0', text: 'Current Fiscal Year' },
      },
    };
    const result = await createReportFromConfig({ ...base(), config: summary });
    assert.deepStrictEqual(result.warnings, []);
    const saved = mock.reports.find((r) => r.id === result.reportId)!;
    assert.strictEqual(saved.access, 'AllUsers');
    assert.strictEqual(saved.folder, 'Budget Reports');
    assert.deepStrictEqual(saved.def.groupings, [
      { key: 'Portals.Name', order: 'Desc', dates: 'Day' },
    ]);
    assert.strictEqual(saved.def.dateDur, '0');

    const exported = await exportReportConfig({ ...base(), reportId: saved.id });
    assert.strictEqual(exported.folder, 'Budget Reports');
    assert.strictEqual(exported.access, 'AllUsers');
    assert.deepStrictEqual(exported.groupings, summary.groupings);
    assert.deepStrictEqual(
      exported.dateFilter,
      summary.dateFilter,
      'no resolved start/end for relative ranges',
    );
    assert.ok(exported.warnings?.some((w) => /role-restricted/.test(w)));
  });

  it('warns about columns and folders that do not exist, and ignores folders for personal reports', async () => {
    const result = await createReportFromConfig({
      ...base(),
      config: {
        ...tabular,
        name: 'RH warnings',
        folder: 'Budget Reports',
        columns: [...tabular.columns, { group: 'ProjectCustomFields', label: 'Nope' }],
      },
    });
    assert.ok(result.warnings.some((w) => /Column not available.*Nope/.test(w)));
    assert.ok(result.warnings.some((w) => /Folder "Budget Reports" ignored/.test(w)));
  });

  it('lists the report tree with folders and types', async () => {
    const items = await fetchReportCatalog({ ...base(), useCache: false });
    const summary = items.find((i) => i.name === 'RH summary');
    assert.strictEqual(summary?.category, 'Budget Reports');
    assert.strictEqual(summary?.type, 'custom');
    assert.strictEqual(items.find((i) => i.name === 'RH tabular')?.category, 'My Personal Reports');
  });

  it('runs a report via its CSV export, honoring the column order and limit', async () => {
    const id = mock.reports[0]!.id;
    const result = await runReport({ ...base(), reportId: id, limit: 2 });
    assert.strictEqual(result.reportName, 'RH tabular');
    assert.deepStrictEqual(result.headers, ['Current Budget', 'Project Name', 'Project Status']);
    assert.strictEqual(result.totalRows, 3);
    assert.strictEqual(result.rows.length, 2);
    assert.strictEqual(result.rows[0]!['Project Name'], 'Project Name 1');
  });

  it('rejects the pre-0.2 config format with a clear message', () => {
    assert.throws(
      () => assertReportConfig({ name: 'x', dataSource: 'Commitments', columns: [] }),
      /Unsupported report config format/,
    );
    assert.doesNotThrow(() => assertReportConfig(tabular));
  });

  describe('fetchProcessSchema', () => {
    it('builds fields, layouts, layout matrix, and workflow steps from the Setup pages', async () => {
      const schema = await fetchProcessSchema({ ...base(), processName: 'rfi', useCache: false });
      assert.strictEqual(schema.name, 'RFI', 'exact match wins over "RFI Response"');
      assert.strictEqual(schema.processId, 'aaaaaaaa-0000-4000-8000-000000000001');
      assert.strictEqual(schema.prefix, 'RFI');
      assert.deepStrictEqual(
        schema.dataFields.map((f) => [f.name, f.type, Boolean(f.required)]),
        [
          ['Question', 'Text Block', true],
          ['Answer', 'Text Block', false],
          ['Internal Notes', 'Text', false],
        ],
      );
      assert.strictEqual(schema.dataFields[0]!.id, 'dddddddd-0000-4000-8000-000000000001');
      assert.deepStrictEqual(schema.layoutMatrix['01 - Start'], {
        Question: 'required',
        'Internal Notes': 'editable',
        Answer: 'hidden',
      });
      assert.deepStrictEqual(schema.layoutMatrix['99 - View Only'], {
        Question: 'readonly',
        Answer: 'readonly',
        'Internal Notes': 'hidden',
      });
      assert.strictEqual(schema.workflow, 'RFI as of 2026');
      assert.deepStrictEqual(
        schema.workflowSteps.map((s) => [s.name, s.type, s.actions, s.actorLayout]),
        [
          ['Start', 'Start', ['Submit'], '01 - Start'],
          ['Answer', 'DataEntry', ['Respond', 'Reject'], '99 - View Only'],
          ['Answered?', 'Conditional', ['true', 'false'], undefined],
          ['Finish', 'Finish', [], undefined],
        ],
      );
      const [start, answer, cond] = schema.workflowSteps;
      assert.deepStrictEqual(start!.actionDetails, [
        { id: 'a1', name: 'Submit', to: 'Answer', toStepId: 's2', status: 'Projected' },
      ]);
      assert.deepStrictEqual(answer!.actors, ['person who took action at Start', 'Architect']);
      assert.deepStrictEqual(answer!.notifyRoles, ['role rrrrrrrr-0000-4000-8000-000000000003']);
      assert.deepStrictEqual(answer!.actionDetails, [
        {
          id: 'a2',
          name: 'Respond',
          to: 'Answered?',
          toStepId: 's4',
          assignments: [
            {
              field: 'Internal Notes',
              fieldId: 'dddddddd-0000-4000-8000-000000000003',
              // Known field GUIDs become [Label]; unknown ones are left as-is.
              expression: '"Re: "&[Answer]&{DataField.eeeeeeee-0000-4000-8000-000000000009}',
            },
          ],
        },
        {
          id: 'a3',
          name: 'Reject',
          to: 'Start',
          toStepId: 's1',
          status: 'Rejected',
          requireComments: true,
          additionalRoles: ['Owner'],
        },
      ]);
      assert.strictEqual(cond!.condition, '[Answer]<>""');
      assert.deepStrictEqual(
        cond!.actionDetails!.map((a) => [a.name, a.conditionResult, a.to]),
        [
          ['true', true, 'Finish'],
          ['false', false, undefined],
        ],
      );
      assert.strictEqual(schema.schemaVersion, PROCESS_SCHEMA_VERSION);

      assert.deepStrictEqual(compactProcessSchema(schema), {
        name: 'RFI',
        processId: 'aaaaaaaa-0000-4000-8000-000000000001',
        prefix: 'RFI',
        fields: ['Question (Text Block)*', 'Answer (Text Block)', 'Internal Notes (Text)'],
        steps: [
          'Start [Start]: Submit -> Answer',
          'Answer [DataEntry]: Respond -> Answered? {sets Internal Notes} | Reject -> Start',
          'Answered? [Conditional: [Answer]<>""]: true -> Finish | false',
          'Finish [Finish]',
        ],
        layouts: ['01 - Start', '99 - View Only'],
      });
    });

    it('renders the schema as Markdown documentation', async () => {
      const schema = await fetchProcessSchema({ ...base(), processName: 'rfi', useCache: false });
      const md = processSchemaToMarkdown(schema);
      const has = (text: string) =>
        assert.ok(md.includes(text), `missing:\n${text}\n--- in ---\n${md}`);
      assert.match(md, /^# RFI \(RFI\)\n/);
      // Steps follow the workflow from Start; Finish is last.
      assert.deepStrictEqual(
        [...md.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1]),
        ['Start', 'Answer', 'Answered?', 'Finish'],
      );
      has('```mermaid\nflowchart TD\n  s0(["Start"])\n  s1["Answer"]\n  s2{"Answered?"}');
      has('  s1 -->|"Reject"| s0');
      assert.ok(!md.includes('-->|"false"|'), 'unconnected branches get no edge');
      has('- **Condition:** `[Answer]<>""`');
      has('| Reject (comment required) | Start | Rejected |  |');
      has('| false | _not connected_ |  |');
      has('- Internal Notes = `"Re: "&[Answer]&{DataField.eeeeeeee-0000-4000-8000-000000000009}`');
      has('**Reject** can add: Owner');
      has('| Question | Question | Text Block | Yes | All |');
      has('| Field | 01 - Start | 99 - View Only |');
      has('| Answer | – | Read |');
    });

    it('matches processes by prefix and variable name', async () => {
      const byPrefix = await fetchProcessSchema({
        ...base(),
        processName: 'rfir',
        useCache: false,
      });
      assert.strictEqual(byPrefix.name, 'RFI Response');
      const byVariable = await fetchProcessSchema({
        ...base(),
        processName: 'Process_RFI',
        useCache: false,
      });
      assert.strictEqual(byVariable.name, 'RFI');
    });

    it('reports ambiguous and unknown process names', async () => {
      await assert.rejects(
        fetchProcessSchema({ ...base(), processName: 'RF', useCache: false }),
        /ambiguous: RFI \(RFI\), RFI Response \(RFIR\)/,
      );
      await assert.rejects(
        fetchProcessSchema({ ...base(), processName: 'Submittal', useCache: false }),
        /not found/,
      );
    });
  });
});
