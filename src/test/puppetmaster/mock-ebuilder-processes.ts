/**
 * Mock of the e-Builder process-instance pages (modelled on live US2 markup):
 * ProcessesMain (security token) + AjaxService GetProjects, ProjectProcesses (startable list and
 * modus-table instance data), StartProcess (submit / draft / validation), and InstanceDetails
 * (actions → comment screen, Save, Accept Ownership). Quirks reproduced:
 * - field edits are silently discarded while step ownership is pending (but "saved" is shown);
 * - the radio field auto-posts back when clicked;
 * - actions always go through the comment screen; some require a comment.
 */
import type * as http from 'http';
import { randomUUID } from 'crypto';

const P = 'ctl00$contentSection$';
const I = 'ctl00_contentSection_';

interface FieldDef {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'radio';
  options?: string[];
  required?: boolean;
  /** Steps where the field is editable. */
  editable: string[];
}
interface ActionDef {
  id: string;
  name: string;
  to: string;
  status?: string;
  requireComment?: boolean;
}
interface ProcessDef {
  name: string;
  prefix: string;
  processId: string;
  hasSubject: boolean;
  fields: FieldDef[];
  steps: Record<string, { actions: ActionDef[]; sharedRole?: boolean }>;
}

export interface MockInstance {
  id: string;
  process: ProcessDef;
  projectId: string;
  counter: number;
  subject: string;
  step: string;
  status: string;
  values: Record<string, string>;
  draft: boolean;
  ownershipPending: boolean;
  comments: Array<{ action: string; text: string; private: boolean }>;
  pendingAction?: ActionDef | undefined;
}

export const PROJECTS = [
  { id: '11111111-aaaa-4000-8000-000000000001', name: 'RH - Test Project', number: 'RH-1' },
  { id: '11111111-aaaa-4000-8000-000000000002', name: 'RH - Test Project 2', number: 'RH-2' },
  { id: '11111111-aaaa-4000-8000-000000000003', name: 'Other Project', number: 'OP-1' },
];

const F = (n: number) => `22222222-bbbb-4000-8000-00000000000${n}`;
export const PROCESSES: ProcessDef[] = [
  {
    name: 'Weather Demo',
    prefix: 'WD',
    processId: '33333333-cccc-4000-8000-000000000001',
    hasSubject: true,
    fields: [
      { id: F(1), label: 'City', type: 'text', editable: ['Start', 'Review'] },
      { id: F(2), label: 'Notes', type: 'textarea', editable: ['Start'] },
      {
        id: F(3),
        label: 'Cost Impact?',
        type: 'radio',
        options: ['Yes', 'No'],
        editable: ['Start', 'Review'],
      },
    ],
    steps: {
      Start: {
        actions: [{ id: '44444444-dddd-4000-8000-000000000001', name: 'Submit', to: 'Review' }],
      },
      Review: {
        sharedRole: true,
        actions: [
          {
            id: '44444444-dddd-4000-8000-000000000002',
            name: 'Approved',
            to: 'Finish',
            status: 'Approved',
          },
          {
            id: '44444444-dddd-4000-8000-000000000003',
            name: 'Revise',
            to: 'Start',
            requireComment: true,
          },
        ],
      },
      Finish: { actions: [] },
    },
  },
  {
    name: 'Asset Approval',
    prefix: 'MPA',
    processId: '33333333-cccc-4000-8000-000000000002',
    hasSubject: false,
    fields: [{ id: F(4), label: 'Asset Tag', type: 'text', required: true, editable: ['Start'] }],
    steps: {
      Start: {
        actions: [{ id: '44444444-dddd-4000-8000-000000000004', name: 'Submit', to: 'Finish' }],
      },
      Finish: { actions: [] },
    },
  },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = (title: string, body: string) =>
  `<!DOCTYPE html><html><head><title>${esc(title)}</title><script>
function __doPostBack(t,a){var f=document.forms[0];f.__EVENTTARGET.value=t;f.__EVENTARGUMENT.value=a||'';f.submit();}
</script></head><body><form id="aspnetForm" method="post">
<input type="hidden" name="__EVENTTARGET" value=""/><input type="hidden" name="__EVENTARGUMENT" value=""/>${body}</form></body></html>`;
const message = (suffix: string, text: string) => `<div id="${I}${suffix}">× ${esc(text)}</div>`;
const hidden = (suffix: string, text: string) =>
  `<div id="${I}${suffix}" style="display:none">× ${esc(text)}</div>`;
const submit = (suffix: string, value: string, onclick = '') =>
  `<input type="submit" name="${P}${suffix}" id="${I}${suffix}" value="${esc(value)}"${onclick ? ` onclick="${esc(onclick)}"` : ''}/>`;

export class MockProcessPages {
  instances: MockInstance[] = [];
  private counters: Record<string, number> = {};

  /** Returns true when the request was handled. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): boolean {
    const url = new URL(req.url ?? '/', 'http://x');
    const b = new URLSearchParams(raw);
    const send = (html: string, type = 'text/html') =>
      res.writeHead(200, { 'Content-Type': type }).end(html);
    const redirect = (to: string) => res.writeHead(302, { Location: to }).end();
    const guid = (v: string | null) => (v ?? '').replace(/[{}]/g, '').toLowerCase();

    switch (url.pathname) {
      case '/da2/Processes/ProcessesMain.aspx':
        send(
          page(
            'Processes',
            `<input type="hidden" id="ctl00_ctl00_ContentPlaceHolder1_contentSection_psCombo_h_securityToken" value="tok-123"/>`,
          ),
        );
        return true;

      case '/da2/Controls/AjaxService.asmx/GetProjects': {
        const ok = JSON.parse(raw || '{}')?.context?.securityToken === 'tok-123';
        if (!ok) {
          res.writeHead(500).end();
          return true;
        }
        send(
          JSON.stringify({
            d: {
              Items: PROJECTS.map((p) => ({
                Text: `${p.name} - ${p.number}`,
                Value: p.id,
                Attributes: { Item1: p.name, Item2: p.number, Item3: '' },
              })),
            },
          }),
          'application/json',
        );
        return true;
      }

      case '/da2/Processes/ProjectProcesses.aspx': {
        const projectId = guid(url.searchParams.get('PortalID'));
        const options = PROCESSES.map((p) => ({
          name: p.name,
          prefix: p.prefix,
          processId: `{${p.processId}}`,
          portalId: `{${projectId}}`,
          workflowId: `{${p.processId}}`,
          description: null,
        }));
        const rows = this.instances
          .filter((i) => i.projectId === projectId && !i.draft && i.step !== 'Finish')
          .map((i) => ({
            instanceId: `{${i.id}}`,
            instanceName: `${i.process.prefix} - ${i.counter}`,
            process: {
              display: `${i.process.prefix} - ${i.counter}`,
              url: `javascript:hrefProcessView('{${i.id}}')`,
            },
            open: { text: 'Open' },
            subject: { display: i.subject },
            step: i.step,
            status: i.status,
          }));
        send(
          page(
            'Project Processes',
            `<modus-table id="t"></modus-table><script>
            function getSelectProcessModalProcessOptions(){ return ${JSON.stringify(options)}; }
            document.getElementById('t').data = ${JSON.stringify(rows)};
            </script>`,
          ),
        );
        return true;
      }

      case '/da2/Processes/StartProcess.aspx': {
        const projectId = guid(url.searchParams.get('PortalID'));
        const proc = PROCESSES.find((p) => p.processId === guid(url.searchParams.get('ProcessID')));
        if (!proc) {
          send(page('e-Builder Error', 'e-Builder Error'));
          return true;
        }
        const draftId = guid(url.searchParams.get('InstanceID'));
        const draft = this.instances.find((i) => i.id === draftId && i.draft);
        if (req.method === 'GET') {
          const flash = url.searchParams.get('formsubmit')
            ? message('divFormSubmitMessage', 'Saved Process instance was submitted successfully.')
            : draft && url.searchParams.get('saved')
              ? message('divSavedMessage', 'Saved Draft Saved Successfully.')
              : '';
          send(this.renderStart(proc, draft, flash));
          return true;
        }
        // POST: apply values
        const values: Record<string, string> = { ...(draft?.values ?? {}) };
        for (const f of proc.fields) {
          const v = b.get(`{${f.id}}`);
          if (v !== null) values[f.id] = v;
        }
        const subject = b.get(`${P}txtSubject`) ?? draft?.subject ?? '';
        const target = b.get('__EVENTTARGET') ?? '';
        if (target.startsWith('{')) {
          // radio auto-postback: re-render with the values kept
          send(
            this.renderStart(
              proc,
              { ...(draft ?? ({} as MockInstance)), values, subject } as MockInstance,
              '',
            ),
          );
          return true;
        }
        if (b.has(`${P}btnSaveDraft`)) {
          const inst = draft ?? this.create(proc, projectId, subject, values, true);
          inst.values = values;
          inst.subject = subject;
          redirect(
            `/da2/Processes/StartProcess.aspx?PortalID=${projectId}&ProcessID=${proc.processId}&InstanceID=${inst.id}&saved=1`,
          );
          return true;
        }
        const missing = proc.fields.filter((f) => f.required && !values[f.id]);
        if (missing.length) {
          send(
            this.renderStart(
              proc,
              { ...(draft ?? ({} as MockInstance)), values, subject } as MockInstance,
              `<div id="${I}divMessageSummary">× <div id="${I}divMessageSummaryHeader">Error: Invalid Data</div><div id="${I}divMessageSummaryContent">Review all error messages below to correct your data.</div></div>` +
                missing
                  .map((f) => `<span class="ValidatorText">${f.label} is required</span>`)
                  .join(''),
            ),
          );
          return true;
        }
        const inst =
          draft ??
          this.create(
            proc,
            projectId,
            subject || (values[proc.fields[0]!.id] ?? ''),
            values,
            false,
          );
        inst.values = values;
        if (proc.hasSubject) inst.subject = subject;
        inst.draft = false;
        this.advance(inst, proc.steps['Start']!.actions[0]!);
        redirect(
          `/da2/Processes/StartProcess.aspx?PortalID=${projectId}&ProcessID=${proc.processId}&formsubmit=1`,
        );
        return true;
      }

      case '/da2/Processes/InstanceDetails.aspx': {
        const inst = this.instances.find((i) => i.id === guid(url.searchParams.get('InstanceID')));
        if (!inst) {
          send(page('e-Builder Error', 'e-Builder Error'));
          return true;
        }
        if (inst.draft) {
          redirect(
            `/da2/Processes/StartProcess.aspx?PortalID=${inst.projectId}&ProcessID=${inst.process.processId}&InstanceID=${inst.id}`,
          );
          return true;
        }
        if (req.method === 'GET') {
          send(this.renderInstance(inst, ''));
          return true;
        }
        const applyValues = () => {
          if (inst.ownershipPending) return; // e-Builder discards edits until ownership is accepted
          for (const f of inst.process.fields) {
            const v = b.get(`{${f.id}}`);
            if (v !== null && f.editable.includes(inst.step)) inst.values[f.id] = v;
          }
        };
        const target = b.get('__EVENTTARGET') ?? '';
        if (target.startsWith('{')) {
          applyValues();
          send(this.renderInstance(inst, ''));
          return true;
        }
        if (b.has(`${P}btnAccept`)) {
          inst.ownershipPending = false;
          send(this.renderInstance(inst, ''));
          return true;
        }
        if (b.has(`${P}btnSave`)) {
          applyValues();
          send(
            this.renderInstance(
              inst,
              message('divSavedMessage', 'Saved Process saved successfully'),
            ),
          );
          return true;
        }
        if (b.has(`${P}btnTakeAction`)) {
          applyValues();
          const actionId = guid(b.get(`${P}ddlActions`));
          inst.pendingAction = inst.process.steps[inst.step]?.actions.find(
            (a) => a.id === actionId,
          );
          send(this.renderComment(inst, ''));
          return true;
        }
        if (b.has(`${P}btnSubmit`) && inst.pendingAction) {
          const note = b.get(`${P}txtNote`) ?? '';
          if (inst.pendingAction.requireComment && !note.trim()) {
            send(
              this.renderComment(inst, '<span class="ValidatorText">Comments are required.</span>'),
            );
            return true;
          }
          if (note)
            inst.comments.push({
              action: inst.pendingAction.name,
              text: note,
              private: b.get(`${P}cbIsPrivate`) === 'on',
            });
          this.advance(inst, inst.pendingAction);
          inst.pendingAction = undefined;
          send(this.renderInstance(inst, ''));
          return true;
        }
        send(this.renderInstance(inst, ''));
        return true;
      }
    }
    return false;
  }

  private create(
    proc: ProcessDef,
    projectId: string,
    subject: string,
    values: Record<string, string>,
    draft: boolean,
  ) {
    const counter = (this.counters[proc.prefix] = (this.counters[proc.prefix] ?? 0) + 1);
    const inst: MockInstance = {
      id: randomUUID(),
      process: proc,
      projectId,
      counter,
      subject,
      step: 'Start',
      status: 'Draft',
      values,
      draft,
      ownershipPending: false,
      comments: [],
    };
    this.instances.push(inst);
    return inst;
  }

  private advance(inst: MockInstance, action: ActionDef) {
    inst.step = action.to;
    inst.status = action.status ?? 'Submitted';
    inst.ownershipPending = Boolean(inst.process.steps[inst.step]?.sharedRole);
  }

  private fieldsHtml(proc: ProcessDef, values: Record<string, string>, step: string | null) {
    return `<table id="${I}dataFields">${proc.fields
      .map((f) => {
        const editable = step === null || f.editable.includes(step);
        const v = values[f.id] ?? '';
        let control: string;
        if (!editable) control = `<span id="{${f.id}}">${esc(v)}</span>`;
        else if (f.type === 'textarea') control = `<textarea name="{${f.id}}">${esc(v)}</textarea>`;
        else if (f.type === 'radio')
          control = `<table class="RadioButtonList">${f
            .options!.map(
              (o, i) =>
                `<input type="radio" name="{${f.id}}" id="r${f.id}_${i}" value="${esc(o)}"${v === o ? ' checked' : ''} onclick="javascript:setTimeout('__doPostBack(\\'{${f.id}}\\',\\'\\')', 0)"/><label for="r${f.id}_${i}">${esc(o)}</label>`,
            )
            .join('')}</table>`;
        else control = `<input type="text" name="{${f.id}}" value="${esc(v)}"/>`;
        return `<tr><td class="Label">${f.required ? '*' : ''}${esc(f.label)}:</td><td>${control}</td></tr>`;
      })
      .join('')}</table>`;
  }

  private renderStart(proc: ProcessDef, draft: MockInstance | undefined, flash: string) {
    return page(
      `${proc.name} (${proc.prefix})`,
      `${flash}${hidden('divSavedMessage', 'Saved Draft Saved Successfully.')}${hidden('divFormSubmitMessage', 'Saved Process instance was submitted successfully.')}
      ${proc.hasSubject ? `<input type="text" name="${P}txtSubject" value="${esc(draft?.subject ?? '')}"/>` : ''}
      ${this.fieldsHtml(proc, draft?.values ?? {}, null)}
      ${submit('btnPostForm', 'Submit')}${submit('btnSaveDraft', 'Save Draft')}`,
    );
  }

  private renderInstance(inst: MockInstance, flash: string) {
    const step = inst.process.steps[inst.step]!;
    const editable = inst.process.fields.some((f) => f.editable.includes(inst.step));
    const name = `${inst.process.prefix} - ${inst.counter}`;
    return page(
      `${inst.process.name} (${inst.process.prefix}) - ${inst.counter}`,
      `${flash}<span id="${I}lblTitleHeader">${esc(inst.process.name)} (${inst.process.prefix}) - ${inst.counter}</span>
      <span id="${I}lblProjectName">${esc(PROJECTS.find((p) => p.id === inst.projectId)!.name)}</span>
      <span id="${I}lblProcess">${name}</span><span id="${I}lblStep">${inst.step}</span>
      <span id="${I}lblSubject">${esc(inst.subject)}</span><span id="${I}lblStatus">${inst.status}</span>
      ${inst.ownershipPending ? submit('btnAccept', 'Accept', "return confirm('If you click Ok, you will be responsible for completing this step.')") : ''}
      ${step.actions.length ? `<select name="${P}ddlActions" id="${I}ddlActions"><option value="">-- Please select an action --</option>${step.actions.map((a) => `<option value="{${a.id}}">${a.name}</option>`).join('')}</select>${submit('btnTakeAction', 'Take Action')}` : ''}
      ${editable ? submit('btnSave', 'Save') : ''}
      ${this.fieldsHtml(inst.process, inst.values, inst.step)}`,
    );
  }

  private renderComment(inst: MockInstance, errors: string) {
    return page(
      `${inst.process.name} (${inst.process.prefix}) - ${inst.counter}`,
      `${errors}<p>Add a comment.</p><textarea name="${P}txtNote" id="${I}txtNote"></textarea>
      <input type="checkbox" name="${P}cbIsPrivate" id="${I}cbIsPrivate"/><label for="${I}cbIsPrivate">Private</label>
      ${submit('btnSubmit', inst.pendingAction?.name ?? 'Submit')}${submit('btnBack', 'No, Cancel')}`,
    );
  }
}
