import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import { Environment } from '../../lib/eb-puppetmaster/index.js';
import {
  acceptProcessOwnership,
  getProcessInstance,
  listProcessInstances,
  listStartableProcesses,
  setProcessInstanceFields,
  startProcessInstance,
  submitProcessDraft,
  takeProcessAction,
} from '../../lib/eb-puppetmaster/process-instance.js';
import { parseFieldInputs, resolveInstanceId } from '../../lib/process-command-utils.js';
import { MockEBuilder } from './mock-ebuilder.js';

describe('Process instances against a mock e-Builder (process-instance.ts)', () => {
  let mock: MockEBuilder;
  let browser: puppeteer.Browser;
  const base = () => ({ env: Environment.US2, cookies: [], browser, origin: mock.origin });
  const project = 'rh - test project';

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

  it('resolves projects by name (exact beats partial) and lists startable processes', async () => {
    const { project: p, processes } = await listStartableProcesses({ ...base(), project });
    assert.strictEqual(p.name, 'RH - Test Project');
    assert.strictEqual(p.number, 'RH-1');
    assert.deepStrictEqual(
      processes.map((x) => x.prefix),
      ['WD', 'MPA'],
    );
    await assert.rejects(listStartableProcesses({ ...base(), project: 'RH - Test' }), /ambiguous/);
    await assert.rejects(listStartableProcesses({ ...base(), project: 'Nope' }), /not found/);
  });

  let wd = '';
  it('starts a process, setting subject, text, textarea, and an auto-postback radio', async () => {
    const result = await startProcessInstance({
      ...base(),
      project,
      process: 'weather demo',
      subject: 'RH test 1',
      fields: { City: 'Denver', Notes: 'line one', 'cost impact': 'Yes' },
    });
    assert.strictEqual(result.submitted, true);
    assert.match(result.message ?? '', /submitted successfully/);
    assert.strictEqual(result.instance?.name, 'WD - 1');
    wd = result.instance!.instanceId;
    const inst = mock.processPages.instances.find((i) => i.id === wd)!;
    assert.deepStrictEqual(Object.values(inst.values).sort(), ['Denver', 'Yes', 'line one']);
    assert.strictEqual(inst.step, 'Review');
  });

  it('reports field-level validation errors and rejects --subject for auto-subject processes', async () => {
    await assert.rejects(
      startProcessInstance({ ...base(), project, process: 'MPA', fields: {} }),
      /Invalid Data.*Asset Tag is required/,
    );
    await assert.rejects(
      startProcessInstance({
        ...base(),
        project,
        process: 'MPA',
        subject: 'x',
        fields: { 'Asset Tag': 'A1' },
      }),
      /generates its subject automatically/,
    );
    await assert.rejects(
      startProcessInstance({ ...base(), project, process: 'WD', fields: { Nope: 'x' } }),
      /Field "Nope" not found/,
    );
  });

  it('lists open instances and views one with actions, fields, and pending ownership', async () => {
    const { instances } = await listProcessInstances({ ...base(), project, process: 'WD' });
    assert.deepStrictEqual(
      instances.map((i) => [i.name, i.step, i.subject]),
      [['WD - 1', 'Review', 'RH test 1']],
    );
    const view = await getProcessInstance({ ...base(), instanceId: `{${wd.toUpperCase()}}` });
    assert.strictEqual(view.currentStep, 'Review');
    assert.strictEqual(view.project, 'RH - Test Project');
    assert.deepStrictEqual(
      view.actions.map((a) => a.name),
      ['Approved', 'Revise'],
    );
    assert.strictEqual(view.ownershipPending, true);
    assert.strictEqual(view.draft, false);
    const notes = view.fields.find((f) => f.label === 'Notes')!;
    assert.deepStrictEqual(
      [notes.type, notes.editable, notes.value],
      ['readonly', false, 'line one'],
    );
    const radio = view.fields.find((f) => f.label === 'Cost Impact?')!;
    assert.deepStrictEqual(
      [radio.type, radio.value, radio.options],
      ['radio', 'Yes', ['Yes', 'No']],
    );
    // Item 1: lookup fields read their own (empty) span, not "[Lookup] [Remove]".
    const lookup = view.fields.find((f) => f.label === 'Related RFI')!;
    assert.deepStrictEqual([lookup.type, lookup.value, lookup.editable], ['readonly', null, false]);
    // Item 2: labels from the embedded commitment sub-control are not process fields.
    assert.ok(!view.fields.some((f) => ['Commitment Type', 'Vendor'].includes(f.label)));
  });

  it('refuses to set fields while ownership is pending, then accepts it on request', async () => {
    await assert.rejects(
      setProcessInstanceFields({ ...base(), instanceId: wd, fields: { City: 'Boulder' } }),
      /ownership has not been accepted.*--accept-ownership/,
    );
    await assert.rejects(
      setProcessInstanceFields({
        ...base(),
        instanceId: wd,
        fields: { Notes: 'x' },
        acceptOwnership: true,
      }),
      /not editable on this step/,
    );
    assert.strictEqual(
      mock.processPages.instances.find((i) => i.id === wd)!.ownershipPending,
      true,
      'a failed call must not accept ownership',
    );
    const set = await setProcessInstanceFields({
      ...base(),
      instanceId: wd,
      fields: { City: 'Boulder', 'Cost Impact?': 'No' },
      acceptOwnership: true,
    });
    assert.strictEqual(set.saved, true);
    assert.strictEqual(set.acceptedOwnership, true);
    const inst = mock.processPages.instances.find((i) => i.id === wd)!;
    assert.strictEqual(inst.ownershipPending, false);
    assert.ok(Object.values(inst.values).includes('Boulder'));
    assert.ok(Object.values(inst.values).includes('No'));
  });

  it('requires a comment for comment-required actions and records it', async () => {
    await assert.rejects(
      takeProcessAction({ ...base(), instanceId: wd, action: 'revise' }),
      /requires a comment.*Comments are required/,
    );
    await assert.rejects(
      takeProcessAction({ ...base(), instanceId: wd, action: 'Reject' }),
      /not available.*Available: Approved, Revise/,
    );
    const revised = await takeProcessAction({
      ...base(),
      instanceId: wd,
      action: 'Revise',
      comment: 'fix it',
      privateComment: true,
    });
    assert.strictEqual(revised.advanced, true);
    assert.deepStrictEqual([revised.before.step, revised.after.currentStep], ['Review', 'Start']);
    const inst = mock.processPages.instances.find((i) => i.id === wd)!;
    assert.deepStrictEqual(inst.comments, [{ action: 'Revise', text: 'fix it', private: true }]);
  });

  it('takes actions without a comment and can set fields as part of the action', async () => {
    const resubmitted = await takeProcessAction({
      ...base(),
      instanceId: wd,
      action: 'submit',
      fields: { Notes: 'updated' },
    });
    assert.strictEqual(resubmitted.after.currentStep, 'Review');
    await acceptProcessOwnership({ ...base(), instanceId: wd });
    const approved = await takeProcessAction({ ...base(), instanceId: wd, action: 'Approved' });
    assert.deepStrictEqual(
      [approved.after.currentStep, approved.after.status],
      ['Finish', 'Approved'],
    );
    assert.deepStrictEqual(approved.after.actions, []);
    const inst = mock.processPages.instances.find((i) => i.id === wd)!;
    assert.ok(Object.values(inst.values).includes('updated'));
  });

  it('saves drafts, edits them, and submits them', async () => {
    const draft = await startProcessInstance({
      ...base(),
      project,
      process: 'WD',
      subject: 'RH draft',
      draft: true,
      fields: { City: 'Golden' },
    });
    assert.strictEqual(draft.draft, true);
    const id = draft.instance!.instanceId;
    assert.match(draft.message ?? '', /Draft Saved/);
    const view = await getProcessInstance({ ...base(), instanceId: id });
    assert.strictEqual(view.draft, true);
    await assert.rejects(
      takeProcessAction({ ...base(), instanceId: id, action: 'Submit' }),
      /unsubmitted draft/,
    );
    const set = await setProcessInstanceFields({
      ...base(),
      instanceId: id,
      fields: { Notes: 'draft note' },
    });
    assert.strictEqual(set.saved, true);
    const submitted = await submitProcessDraft({
      ...base(),
      instanceId: id,
      fields: { 'Cost Impact?': 'Yes' },
    });
    assert.strictEqual(submitted.instance.draft, false);
    assert.strictEqual(submitted.instance.currentStep, 'Review');
    const inst = mock.processPages.instances.find((i) => i.id === id)!;
    assert.deepStrictEqual(Object.values(inst.values).sort(), ['Golden', 'Yes', 'draft note']);
  });

  it('lists closed, draft, and all instances, restoring the page filter afterwards', async () => {
    const draft = await startProcessInstance({
      ...base(),
      project,
      process: 'WD',
      subject: 'RH filter draft',
      draft: true,
    });
    const names = async (status: 'open' | 'closed' | 'draft' | 'all') =>
      (await listProcessInstances({ ...base(), project, status })).instances.map((i) => [
        i.name,
        i.state,
      ]);
    const open = await names('open');
    assert.ok(open.every(([, state]) => state === 'Open'));
    assert.deepStrictEqual(await names('closed'), [['WD - 1', 'Closed']]);
    assert.ok((await names('draft')).some(([, state]) => state === 'Draft'));
    const all = await names('all');
    assert.strictEqual(all.length, open.length + 2);
    assert.deepStrictEqual(mock.processPages.filter['InProgress'], true, 'filter restored');
    assert.deepStrictEqual(mock.processPages.filter['Completed'], false, 'filter restored');
    assert.ok(draft.instance);
  });

  it('resolves closed instances by name', async () => {
    const id = await resolveInstanceId(
      { env: Environment.US2, cookies: [], origin: mock.origin, browser } as any,
      'wd - 1',
      project,
    );
    assert.strictEqual(id, wd);
  });

  it('decodes HTML entities in instance data and still finds new instances by subject', async () => {
    const started = await startProcessInstance({
      ...base(),
      project,
      process: 'WD',
      subject: 'RH P&L <review>',
    });
    assert.strictEqual(started.instance?.subject, 'RH P&L <review>');
    const { instances } = await listProcessInstances({ ...base(), project, search: 'P&L' });
    assert.deepStrictEqual(
      instances.map((i) => i.subject),
      ['RH P&L <review>'],
    );
  });

  it('parses --field and --fields inputs', () => {
    assert.deepStrictEqual(parseFieldInputs(['A=1', 'B = x=y', 'C='], '{"D": true}'), {
      D: true,
      A: '1',
      B: ' x=y',
      C: '',
    });
    assert.throws(() => parseFieldInputs(['nope'], undefined), /Label=value/);
    assert.throws(() => parseFieldInputs(undefined, '[1]'), /JSON object/);
  });
});
