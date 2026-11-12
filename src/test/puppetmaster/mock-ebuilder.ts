/**
 * Minimal mock of the e-Builder pages that report.ts / process-schema.ts drive, modelled on the
 * live US2 markup: control names, step flow, postbacks, SaveReport.aspx, the report tree, the
 * CSV export, and the process Setup pages. Postbacks are full form posts (the real wizard uses
 * UpdatePanels; the driver handles both).
 *
 * It also reproduces a real quirk: after a save, the server-side wizard session stays bound to
 * the saved report, and "Save As" from AddEditReport.aspx (without Reports → Add Report) fails
 * with the e-Builder error page.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { MockProcessPages } from './mock-ebuilder-processes.js';

const P = 'ctl00$ctl00$ContentPlaceHolder1$contentSection$';
const I = 'ctl00_ctl00_ContentPlaceHolder1_contentSection_';

const TYPES: Record<string, { text: string; subs: Record<string, string> }> = {
  '3': { text: 'Cost Reports', subs: { '6': 'Budget Line Item', '7': 'Commitments' } },
  '8': { text: 'Administrative Reports', subs: { '40': 'Users' } },
};
const COLUMNS = [
  { group: 'ProjectInformation', label: 'Project Name', key: 'Portals.Name' },
  { group: 'ProjectInformation', label: 'Project Status', key: 'PortalStatus.StatusID' },
  { group: 'ProjectInformation', label: 'Create Date', key: 'Portals.CreateDate' },
  {
    group: 'CostSummary',
    label: 'Current Budget',
    key: 'CostSummary.CurrentBudget',
    numeric: true,
  },
];
const OPERATORS = [
  ['1', 'equals'],
  ['2', 'does not equal'],
  ['7', 'contains'],
  ['9', 'starts with'],
];
const FOLDERS = [
  { id: '{11111111-1111-1111-1111-111111111111}', name: 'Budget Reports' },
  { id: '{22222222-2222-2222-2222-222222222222}', name: 'Dashboard - Admin' },
];

interface WizardState {
  step: string;
  type: string;
  sub: string;
  style: string;
  columns: Set<string>;
  expand: boolean;
  order: string[];
  aggs: Set<string>;
  sorts: Array<{ key: string; dir: string }>;
  groupings: Array<{ key: string; order: string; dates: string }>;
  dateCol: string;
  dateDur: string;
  start: string;
  end: string;
  requireProject: boolean;
  filters: Array<{ field: string; op: string; value: string }>;
  /** Report the server session is bound to (set by loading or saving one). */
  boundReportId: string | null;
  /** True after Reports → Add Report (fresh wizard). */
  fresh: boolean;
}

export interface SavedReport {
  id: string;
  name: string;
  description: string;
  access: string;
  folder: string;
  def: Omit<WizardState, 'step' | 'boundReportId' | 'fresh'>;
}

const freshState = (): WizardState => ({
  step: 'DataType',
  type: '3',
  sub: '6',
  style: '1',
  columns: new Set(),
  expand: false,
  order: [],
  aggs: new Set(),
  sorts: [],
  groupings: [],
  dateCol: 'Portals.CreateDate',
  dateDur: '255',
  start: '',
  end: '',
  requireProject: false,
  filters: [],
  boundReportId: null,
  fresh: true,
});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = (title: string, body: string) =>
  `<!DOCTYPE html><html><head><title>${title}</title><script>
function __doPostBack(t,a){var f=document.forms[0];f.__EVENTTARGET.value=t;f.__EVENTARGUMENT.value=a||'';f.submit();}
</script></head><body><form id="aspnetForm" method="post">
<input type="hidden" name="__EVENTTARGET" value=""/><input type="hidden" name="__EVENTARGUMENT" value=""/>
<input type="hidden" name="__VIEWSTATE" value="mock"/>${body}</form></body></html>`;
const select = (
  name: string,
  options: Array<[string, string]>,
  selected: string,
  postback = false,
  extra = '',
) =>
  `<select name="${P}${name}" id="${I}${name}" ${
    postback ? `onchange="javascript:setTimeout('__doPostBack(\\'${P}${name}\\',\\'\\')', 0)"` : ''
  } ${extra}>${options
    .map(
      ([v, t]) =>
        `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(t)}</option>`,
    )
    .join('')}</select>`;
const button = (name: string, text: string) =>
  `<input type="button" name="${P}${name}" id="${I}${name}" value="${text}" onclick="javascript:__doPostBack('${P}${name}','')"/>`;

const stepsFor = (s: WizardState) => [
  'DataType',
  'Style',
  'Columns',
  'Aggregate',
  'ReorderColumns',
  ...(s.style === '2' ? ['Grouping'] : []),
  'Criteria',
];
const selectedColumns = (s: WizardState) =>
  COLUMNS.filter((c) => s.columns.has(`${c.group}|${c.label}`));

function renderWizard(s: WizardState): string {
  const steps = stepsFor(s);
  const stepSel = select(
    'ddlSteps',
    steps.map((x) => [x, x]),
    s.step,
    true,
  );
  const isLast = s.step === steps[steps.length - 1];
  const nav = (n: string) =>
    `${button(`btnSaveAs${n}`, 'Save As')}${isLast ? '' : button(`btnNext${n}`, 'Next')}`;
  let body = '';
  switch (s.step) {
    case 'DataType':
      body = `<div id="${I}pnlStep1">${select(
        'ddlReportType',
        Object.entries(TYPES).map(([v, t]) => [v, t.text]),
        s.type,
        true,
      )}${select('lbReportSubType', Object.entries(TYPES[s.type]!.subs), s.sub, true)}${nav('11')}</div>`;
      break;
    case 'Style':
      body = `<div id="${I}pnlStep2">${['Tabular', 'Summary', 'Matrix']
        .map(
          (t, i) =>
            `<input type="radio" name="${P}rblReportStyle" id="${I}rblReportStyle_${i}" value="${i + 1}"${
              String(i + 1) === s.style ? ' checked' : ''
            }/><label for="${I}rblReportStyle_${i}"><b>${t}</b> Report: ${t} reports...</label>`,
        )
        .join('')}${nav('21')}</div>`;
      break;
    case 'Columns': {
      const groups = [...new Set(COLUMNS.map((c) => c.group))];
      body = `<div id="${I}pnlStep3"><input type="checkbox" name="${P}chkExpandMPL" id="${I}chkExpandMPL"${
        s.expand ? ' checked' : ''
      }/>${groups
        .map((g) =>
          COLUMNS.filter((c) => c.group === g)
            .map((c, i) => {
              const id = `${I}cbl${g}_${i}`;
              return `<input type="checkbox" name="${P}cbl${g}$${i}" id="${id}"${
                s.columns.has(`${g}|${c.label}`) ? ' checked' : ''
              }/><label for="${id}">${c.label}</label>`;
            })
            .join(''),
        )
        .join('')}${nav('31')}</div>`;
      break;
    }
    case 'Aggregate':
      body = `<div id="${I}pnlStep325"><table id="${I}dgAggregateColumns"><tr><td>Column</td><td>Sum</td></tr>${selectedColumns(
        s,
      )
        .filter((c) => c.numeric)
        .map(
          (c, i) =>
            `<tr><td>${c.label}</td><td><input type="checkbox" name="${P}dgAggregateColumns$ctl0${i + 2}$chkSum"${
              s.aggs.has(c.label) ? ' checked' : ''
            }/></td></tr>`,
        )
        .join('')}</table>${nav('3251')}</div>`;
      break;
    case 'ReorderColumns': {
      const byKey = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
      const opts: Array<[string, string]> = [
        ['', ''],
        ...s.order.map((k): [string, string] => [k, byKey[k]!]),
      ];
      body = `<div id="${I}pnlStep35"><select multiple name="${P}radLbReportColumns" id="${I}radLbReportColumns">${s.order
        .map((k) => `<option value="${k}">${byKey[k]}</option>`)
        .join(
          '',
        )}</select><input type="image" name="${P}radBtnTop" id="${I}radBtnTop" src="data:,"/>${[
        1, 2, 3,
      ]
        .map(
          (i) =>
            select(`ddlSortCol${i}`, opts, s.sorts[i - 1]?.key ?? '') +
            ['0', '1']
              .map(
                (v) =>
                  `<input type="radio" name="${P}rblSortCol${i}" value="${v}"${
                    (s.sorts[i - 1]?.dir ?? '0') === v ? ' checked' : ''
                  }/>`,
              )
              .join(''),
        )
        .join('')}${nav('351')}</div>`;
      break;
    }
    case 'Grouping': {
      const opts: Array<[string, string]> = [
        ['', ''],
        ...COLUMNS.map((c): [string, string] => [c.key, c.label]),
      ];
      body = `<div id="${I}pnlStep4">${[1, 2]
        .map(
          (i) =>
            select(`ddlColumns${i}`, opts, s.groupings[i - 1]?.key ?? '', true) +
            select(
              'ddlSortOrder' + i,
              [
                ['Asc', 'Ascending'],
                ['Desc', 'Descending'],
              ],
              s.groupings[i - 1]?.order ?? 'Asc',
            ) +
            select(
              'ddlGroupDates' + i,
              [
                ['Day', 'Day'],
                ['Month', 'Month'],
                ['Year', 'Year'],
              ],
              s.groupings[i - 1]?.dates ?? 'Day',
            ),
        )
        .join('')}${nav('41')}</div>`;
      break;
    }
    case 'Criteria': {
      const fieldOpts: Array<[string, string]> = [
        ['Empty', ''],
        ...COLUMNS.map((c): [string, string] => [c.key, c.label]),
      ];
      body = `<div id="${I}pnlStep5">${select(
        'ddlStdDateColumns',
        [['Portals.CreateDate', 'Create Date']],
        s.dateCol,
        true,
      )}${select(
        'ddlStdDateDuration',
        [
          ['255', 'Custom'],
          ['0', 'Current Fiscal Year'],
        ],
        s.dateDur,
        true,
      )}
      <input type="text" name="${P}rdStdDateStart" value="${s.dateDur === '0' ? '2026-01-01' : s.start}"/>
      <input type="text" name="${P}rdStdDateEnd" value="${s.dateDur === '0' ? '2026-12-31' : s.end}"/>
      <input type="checkbox" name="${P}chkProjectFilter"${s.requireProject ? ' checked' : ''}/>${[
        1, 2, 3,
      ]
        .map((i) => {
          const f = s.filters[i - 1];
          return (
            select(`ddlField${i}`, fieldOpts, f?.field ?? 'Empty', true) +
            select(
              `ddlCriteria${i}`,
              [['Empty', ''], ...(OPERATORS as Array<[string, string]>)],
              f?.op ?? 'Empty',
              true,
            ) +
            `<input type="text" name="${P}txtValue${i}" value="${esc(f?.value ?? '')}"/>`
          );
        })
        .join('')}${nav('52')}</div>`;
      break;
    }
  }
  return page('Report Wizard', `${stepSel}${body}`);
}

/** Applies posted control values for the step that was rendered (like ASP.NET does). */
function applyPost(s: WizardState, b: URLSearchParams, target: string) {
  const v = (n: string) => b.get(P + n);
  switch (s.step) {
    case 'DataType': {
      const type = v('ddlReportType') ?? s.type;
      if (type !== s.type) {
        s.type = type;
        s.sub = Object.keys(TYPES[type]!.subs)[0]!;
      } else if (v('lbReportSubType')) s.sub = v('lbReportSubType')!;
      break;
    }
    case 'Style':
      s.style = v('rblReportStyle') ?? s.style;
      break;
    case 'Columns': {
      s.expand = v('chkExpandMPL') === 'on';
      const groups = [...new Set(COLUMNS.map((c) => c.group))];
      s.columns = new Set();
      for (const g of groups) {
        COLUMNS.filter((c) => c.group === g).forEach((c, i) => {
          if (v(`cbl${g}$${i}`) === 'on') s.columns.add(`${g}|${c.label}`);
        });
      }
      const keys = selectedColumns(s).map((c) => c.key);
      s.order = [
        ...s.order.filter((k) => keys.includes(k)),
        ...keys.filter((k) => !s.order.includes(k)),
      ];
      break;
    }
    case 'Aggregate':
      s.aggs = new Set();
      selectedColumns(s)
        .filter((c) => c.numeric)
        .forEach((c, i) => {
          if (v(`dgAggregateColumns$ctl0${i + 2}$chkSum`) === 'on') s.aggs.add(c.label);
        });
      break;
    case 'ReorderColumns':
      s.sorts = [1, 2, 3]
        .map((i) => ({ key: v(`ddlSortCol${i}`) ?? '', dir: v(`rblSortCol${i}`) ?? '0' }))
        .filter((x) => x.key);
      if (b.has(P + 'radBtnTop.x')) {
        const k = v('radLbReportColumns');
        if (k) s.order = [k, ...s.order.filter((x) => x !== k)];
      }
      break;
    case 'Grouping':
      s.groupings = [1, 2]
        .map((i) => ({
          key: v(`ddlColumns${i}`) ?? '',
          order: v(`ddlSortOrder${i}`) ?? 'Asc',
          dates: v(`ddlGroupDates${i}`) ?? 'Day',
        }))
        .filter((g) => g.key);
      break;
    case 'Criteria':
      s.dateCol = v('ddlStdDateColumns') ?? s.dateCol;
      s.dateDur = v('ddlStdDateDuration') ?? s.dateDur;
      s.start = v('rdStdDateStart') ?? '';
      s.end = v('rdStdDateEnd') ?? '';
      s.requireProject = v('chkProjectFilter') === 'on';
      s.filters = [1, 2, 3]
        .map((i) => ({
          field: v(`ddlField${i}`) ?? 'Empty',
          op: v(`ddlCriteria${i}`) ?? 'Empty',
          value: v(`txtValue${i}`) ?? '',
        }))
        .filter((f) => f.field !== 'Empty');
      break;
  }
  if (/btnNext/.test(target) || /btnNext/.test([...b.keys()].join(' '))) {
    const steps = stepsFor(s);
    s.step = steps[Math.min(steps.indexOf(s.step) + 1, steps.length - 1)]!;
  }
}

const snapshot = (s: WizardState): SavedReport['def'] => {
  const { step: _a, boundReportId: _b, fresh: _c, ...def } = s;
  return {
    ...def,
    columns: new Set(def.columns),
    aggs: new Set(def.aggs),
    order: [...def.order],
    sorts: def.sorts.map((x) => ({ ...x })),
    groupings: def.groupings.map((x) => ({ ...x })),
    filters: def.filters.map((x) => ({ ...x })),
  };
};

/** Mock process setup data. */
const PROCESS = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: 'RFI',
  prefix: 'RFI',
  layouts: [
    { id: 'bbbbbbbb-0000-4000-8000-000000000001', name: '01 - Start' },
    { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: '99 - View Only' },
  ],
  workflowId: 'cccccccc-0000-4000-8000-000000000001',
};

export class MockEBuilder {
  server!: http.Server;
  origin = '';
  state: WizardState = freshState();
  /** Process-instance pages (start / view / set / actions). */
  processPages = new MockProcessPages();
  reports: SavedReport[] = [];
  /** Session-binding quirk can be disabled to compare behaviour. */
  saveErrors = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          this.handle(req, res, body);
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e?.stack ?? e));
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server.close(r));
  }

  private send(res: http.ServerResponse, html: string, type = 'text/html') {
    res.writeHead(200, { 'Content-Type': type }).end(html);
  }

  private redirect(res: http.ServerResponse, to: string) {
    res.writeHead(302, { Location: to }).end();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string) {
    const url = new URL(req.url ?? '/', 'http://x');
    const b = new URLSearchParams(raw);
    const target = b.get('__EVENTTARGET') ?? '';
    const path = url.pathname;
    const s = this.state;
    if (this.processPages.handle(req, res, raw)) return;

    if (path === '/da2/Reports/index.aspx') {
      if (req.method === 'POST' && /btnAddStandardReport/.test(target)) {
        this.state = freshState();
        return this.redirect(res, '/da2/Reports/AddEditReport.aspx');
      }
      const item = (r: SavedReport) =>
        `<modus-tree-view-item node-id="${r.id}"><div slot="label" class="report-label-box"><a href="/da2/Reports/ReportResults.aspx?ReportID=${r.id}">${esc(
          r.name,
        )}</a><div class="report-description">${esc(r.description)}</div></div></modus-tree-view-item>`;
      const folder = (id: string, name: string, items: SavedReport[]) =>
        `<modus-tree-view-item node-id="${id}"><div slot="label">${name}</div>${items.map(item).join('')}</modus-tree-view-item>`;
      return this.send(
        res,
        page(
          'Reports',
          `<a id="${I}ReportList_btnAddStandardReport2" href="javascript:__doPostBack('${P}ReportList$btnAddStandardReport2','')" style="display:none">Add Report</a>
          <modus-tree-view id="modusTreeView">${folder(
            '{00000000-0000-0000-0000-000000000000}',
            'My Personal Reports',
            this.reports.filter((r) => r.access === 'Personal'),
          )}${folder(
            '{ffffffff-ffff-ffff-ffff-ffffffffffff}',
            'Unfiled Account Reports',
            this.reports.filter((r) => r.access !== 'Personal' && !r.folder),
          )}${FOLDERS.map((f) =>
            folder(
              f.id,
              f.name,
              this.reports.filter((r) => r.access !== 'Personal' && r.folder === f.name),
            ),
          ).join('')}</modus-tree-view>`,
        ),
      );
    }

    if (path === '/da2/Reports/AddEditReport.aspx') {
      if (req.method === 'GET') {
        const id = url.searchParams.get('ReportID');
        if (id) {
          const r = this.reports.find((x) => x.id === id);
          if (!r) return this.send(res, page('e-Builder Error', 'e-Builder Error'));
          const d = snapshot({ ...freshState(), ...r.def });
          this.state = { ...freshState(), ...d, step: 'DataType', boundReportId: id, fresh: false };
        }
        return this.send(res, renderWizard(this.state));
      }
      applyPost(s, b, target);
      if (/btnSaveAs/.test(target)) return this.redirect(res, '/da2/Reports/SaveReport.aspx');
      return this.send(res, renderWizard(s));
    }

    if (path === '/da2/Reports/SaveReport.aspx') {
      if (req.method === 'GET') {
        return this.send(
          res,
          page(
            'Save Report',
            `<input type="text" name="${P}txtReportName" id="${I}txtReportName"/>
            <input type="text" name="${P}txtReportDescription" id="${I}txtReportDescription"/>
            ${['Personal', 'AllUsers']
              .map(
                (v, i) =>
                  `<input type="radio" name="${P}rblRadAccessType" id="${I}rblRadAccessType_${i}" value="${v}"${
                    i === 0 ? ' checked' : ''
                  } onclick="document.getElementById('${I}ddlReportFolders').disabled = this.value === 'Personal'"/>`,
              )
              .join('')}
            ${select('ddlReportFolders', [['', 'Unfiled Account Reports'], ...FOLDERS.map((f): [string, string] => [f.id, f.name])], '', false, 'disabled')}
            <input type="submit" name="${P}btnSave1" id="${I}btnSave1" value="Save"/>`,
          ),
        );
      }
      if (s.boundReportId && !s.fresh) {
        this.saveErrors++;
        return this.send(res, page('e-Builder Error', '<div id="Content1">e-Builder Error</div>'));
      }
      const folderId = b.get(P + 'ddlReportFolders') ?? '';
      const report: SavedReport = {
        id: randomUUID(),
        name: b.get(P + 'txtReportName') ?? '',
        description: b.get(P + 'txtReportDescription') ?? '',
        access: b.get(P + 'rblRadAccessType') ?? 'Personal',
        folder: FOLDERS.find((f) => f.id === folderId)?.name ?? '',
        def: snapshot(s),
      };
      this.reports.push(report);
      s.boundReportId = report.id;
      s.fresh = false;
      return this.redirect(res, '/da2/Reports/index.aspx');
    }

    if (path === '/da2/Reports/ReportResults.aspx') {
      const r = this.reports.find((x) => x.id === url.searchParams.get('ReportID'));
      if (!r) return this.send(res, page('e-Builder Error', 'e-Builder Error'));
      if (req.method === 'POST') {
        const ok = b.get(P + 'rblExportTypes') === '5' && b.get(P + 'btnExportType') === 'Export';
        if (!ok) return this.send(res, '<html>not exported</html>');
        const byKey = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));
        const headers = r.def.order.map((k) => byKey[k]!);
        const rows = [1, 2, 3].map((n) => headers.map((h) => `"${h} ${n}"`).join(','));
        return this.send(
          res,
          [headers.map((h) => `"${h}"`).join(','), ...rows].join('\r\n'),
          'text/csv',
        );
      }
      return this.send(
        res,
        page(
          'Report Results',
          `<span id="${I}lblReportName">${esc(r.name)}</span>
          <input type="radio" name="${P}rblExportTypes" value="3" checked/><input type="radio" name="${P}rblExportTypes" value="5"/>
          <input type="submit" name="${P}btnExportType" value="Export"/>`,
        ),
      );
    }

    // ---- Process setup pages ----
    const pid = `{${PROCESS.id}}`;
    if (path === '/da2/Setup/Admin/Processes/ManageProcesses.aspx') {
      return this.send(
        res,
        page(
          'Processes',
          `<table id="${I}grdProcesses" class="TableGrid"><tr><td><a>Name</a></td><td><a>Prefix</a></td><td><a>Variable Name</a></td><td><a>Description</a></td><td><a>Project Assignment</a></td><td><a>Active</a></td></tr>
          <tr><td><a href="/da2/Setup/Admin/Processes/ViewProcess.aspx?ProcessID=${pid}">RFI</a></td><td>RFI</td><td>Process_RFI</td><td>Requests</td><td>All Projects</td><td></td></tr>
          <tr><td><a href="/da2/Setup/Admin/Processes/ViewProcess.aspx?ProcessID={aaaaaaaa-0000-4000-8000-000000000009}">RFI Response</a></td><td>RFIR</td><td>Process_RFIR</td><td></td><td>All Projects</td><td></td></tr></table>`,
        ),
      );
    }
    if (path === '/da2/Setup/Admin/Processes/ManageDataFields.aspx') {
      return this.send(
        res,
        page(
          'RFI',
          `<table id="${I}dgFields" class="TableGrid"><tr><td></td><td>Label</td><td>Variable Name</td><td>Data Type</td><td>Permission</td><td>Unique</td></tr>
          <tr><td>Edit</td><td>Question</td><td>Question</td><td>Text Block</td><td>All</td><td></td></tr>
          <tr><td>Edit</td><td>Answer</td><td>Answer</td><td>Text Block</td><td>All</td><td></td></tr>
          <tr><td>Edit</td><td>Internal Notes</td><td>Internal_Notes</td><td>Text</td><td>All</td><td></td></tr></table>`,
        ),
      );
    }
    if (path === '/da2/Setup/Admin/Processes/ManageLayouts.aspx') {
      return this.send(
        res,
        page(
          'RFI',
          `<table id="${I}grdLayouts" class="TableGrid"><tr><td>Layout Name</td><td>In Use</td></tr>${PROCESS.layouts
            .map(
              (l) =>
                `<tr><td><a href="/da2/Setup/Admin/Processes/ViewLayout.aspx?LayoutID={${l.id}}&ProcessID=${pid}">${l.name}</a></td><td>Yes</td></tr>`,
            )
            .join('')}</table>`,
        ),
      );
    }
    if (path === '/da2/Setup/Admin/Processes/ManageWorkflows.aspx') {
      return this.send(
        res,
        page(
          'RFI',
          `<table id="${I}grdWorkflows" class="TableGrid"><tr><td>Workflow Name</td><td>Project Assignments</td><td>Date Published</td><td>Last Used</td></tr>
          <tr><td><a href="/da2/Setup/Admin/Processes/ViewWorkflow.aspx?WorkflowID={${PROCESS.workflowId}}&ProcessID=${pid}">RFI as of 2026</a></td><td>Account Default</td><td>01.01.2026</td><td>02.01.2026</td></tr></table>`,
        ),
      );
    }
    if (path === '/da2/Setup/Admin/Processes/AddEditLayout.aspx') {
      const lid = url.searchParams.get('LayoutID');
      const field = (name: string, id: string, ro: boolean, req: boolean) =>
        `<ebSectionField><DataFieldID>${id}</DataFieldID><DataFieldName>${name}</DataFieldName><IsReadOnly>${ro}</IsReadOnly><IsRequired>${req}</IsRequired></ebSectionField>`;
      const fields =
        lid === PROCESS.layouts[0]!.id
          ? field('Question', 'dddddddd-0000-4000-8000-000000000001', false, true) +
            field('Internal Notes', 'dddddddd-0000-4000-8000-000000000003', false, false)
          : field('Question', 'dddddddd-0000-4000-8000-000000000001', true, false) +
            field('Answer', 'dddddddd-0000-4000-8000-000000000002', true, false);
      return this.send(
        res,
        `<?xml version="1.0"?><ebLayout><Sections><ebSection><SectionFields>${fields}</SectionFields></ebSection></Sections></ebLayout>`,
        'text/xml',
      );
    }
    if (path === '/da2/Setup/Admin/Processes/WorkflowDesigner.aspx') {
      return this.send(
        res,
        `<html><body><script>var ucDesigner = new WorkflowDesigner({"token":"tok-1"});ucDesigner.load('${PROCESS.id}','${PROCESS.workflowId}', 3)</script></body></html>`,
      );
    }
    if (path === '/da2/Processes/ProcessesService.asmx/GetWorkflowData') {
      const [l1, l2] = PROCESS.layouts;
      const Z = '00000000-0000-0000-0000-000000000000';
      const xml = `<ebWorkflow><Steps>
        <ebStep StepID="s1" Name="Start" StepType="Start" ActorLayoutID="${l1!.id}" NonActorLayoutID="${Z}" ConditionalBranchExpression="" SpawnProcessID=""><Actors/><Actions><ebAction ActionID="a1" Name="Submit" ButtonText="Submit" Status="Projected"><DataFieldAssignments/><ActionRoles/></ebAction></Actions></ebStep>
        <ebStep StepID="s2" Name="Answer" StepType="DataEntry" ActorLayoutID="${l2!.id}" ConditionalBranchExpression="" SpawnProcessID=""><Actors><ebActor RoleID="${Z}" ParticipantType="PersonTakingAction" ParticipantInStepID="s1"/><ebActor RoleID="rrrrrrrr-0000-4000-8000-000000000001" RoleName="Architect" ParticipantType="None" ParticipantInStepID="${Z}"/></Actors><Actions>
          <ebAction ActionID="a2" Name="Respond" ButtonText="Respond" Status="NotAssigned"><DataFieldAssignments><ebDataFieldAssignment DataFieldID="dddddddd-0000-4000-8000-000000000003" DataFieldName="Internal Notes" AssignmentExpression="&quot;Re: &quot;&amp;{DataField.dddddddd-0000-4000-8000-000000000002}&amp;{DataField.eeeeeeee-0000-4000-8000-000000000009}"/></DataFieldAssignments><ActionRoles/></ebAction>
          <ebAction ActionID="a3" Name="Reject" ButtonText="Reject" Status="Rejected" RequireComments="true"><DataFieldAssignments/><ActionRoles><ebActionRole RoleID="rrrrrrrr-0000-4000-8000-000000000002" RoleName="Owner" Type="AdditionalActor"/></ActionRoles></ebAction></Actions><NotifyRoles><ebNotifyRole RoleID="rrrrrrrr-0000-4000-8000-000000000003"/></NotifyRoles></ebStep>
        <ebStep StepID="s4" Name="Answered?" StepType="Conditional" ConditionalBranchExpression="{DataField.dddddddd-0000-4000-8000-000000000002}&lt;&gt;&quot;&quot;" SpawnProcessID=""><Actors/><Actions><ebAction ActionID="a4" Name="true" ButtonText="true" ConditionalBranchExpressionValue="true" Status="NotAssigned"><DataFieldAssignments/></ebAction><ebAction ActionID="a5" Name="false" ButtonText="false" ConditionalBranchExpressionValue="false" Status="NotAssigned"><DataFieldAssignments/></ebAction></Actions></ebStep>
        <ebStep StepID="s3" Name="Finish" StepType="Finish"><Actions/></ebStep></Steps>
        <Connectors>
          <ebConnector ActionID="a1" FromStepID="s1" ToStepID="s2"/>
          <ebConnector ActionID="a2" FromStepID="s2" ToStepID="s4"/>
          <ebConnector ActionID="a3" FromStepID="s2" ToStepID="s1"/>
          <ebConnector ActionID="a4" FromStepID="s4" ToStepID="s3"/>
          <ebConnector ActionID="a5" FromStepID="s4" ToStepID="${Z}"/>
        </Connectors></ebWorkflow>`;
      return this.send(res, JSON.stringify({ d: { xml, isActive: true } }), 'application/json');
    }

    res.writeHead(404).end();
  }
}
