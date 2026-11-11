import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import puppeteer from 'puppeteer';
import { BrowserManager } from '../../lib/eb-puppetmaster/index.js';
import {
  applyProjectSettingsOnPage,
  diffProjectSettings,
  normalizeWorkTime,
  parseProjectSettingsInput,
  parseWorkWeek,
  readProjectSaveErrors,
  readProjectSettingsFromPage,
  validateProjectSettings,
} from '../../lib/eb-puppetmaster/project-settings.js';

const P = 'ctl00_ctl00_ContentPlaceHolder1_contentSection_';
const N = 'ctl00$ctl00$ContentPlaceHolder1$contentSection$';

function radios(name: string, options: [string, string, boolean][], onclick = ''): string {
  return `<table id="${P}${name}"${onclick ? ` onclick="${onclick}"` : ''}><tbody>${options
    .map(
      ([value, label, checked], i) =>
        `<tr><td><input id="${P}${name}_${i}" type="radio" name="${N}${name}" value="${value}"${checked ? ' checked' : ''}><label for="${P}${name}_${i}">${label}</label></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function hours(selected: string, id: string, style = ''): string {
  const opts: string[] = [];
  for (let h = 0; h < 24; h++) {
    const v = `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'am' : 'pm'}`;
    opts.push(`<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`);
  }
  return `<select name="${N}${id}" id="${P}${id}"${style ? ` style="${style}"` : ''}>${opts.join('')}</select>`;
}

/** Trimmed from the real Settings tab markup (US2, 2026-11-11). */
function settingsPage(opts: { docControlRowHidden?: boolean; startTimeHidden?: boolean } = {}) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `<!DOCTYPE html><html><body><form>
    <input name="${N}tbProjectName" id="${P}tbProjectName" value="RH - Fixture Project">
    <input type="hidden" id="${P}SettingsModified" value="false">
    <input type="hidden" id="${P}CustomFieldModified" value="false">
    <div id="${P}pvSettings" class="rmpView rmpHidden" style="display:none">
      <table><tbody>
        <tr><td class="Label">Project Access</td><td>${radios('rblAllowUserLogins', [
          ['1', 'Visible to All Users', true],
          ['0', 'Hidden from All Users', false],
        ])}</td></tr>
        <tr><td class="Label">Deny Techsupport Access?</td><td>${radios('rblDenyTechsupport', [
          ['1', 'Yes, e-Builder employees cannot access this project', false],
          ['0', 'No, e-Builder employees can access this project', true],
        ])}</td></tr>
        <tr id="${P}trDocumentControl"${opts.docControlRowHidden ? ' style="display:none"' : ''}>
          <td class="Label">Enable Document Control?</td><td>${radios(
            'rblEnableDocumentControl',
            [
              ['1', 'Yes', true],
              ['0', 'No', false],
            ],
            'setPlanRoomRowVisibility();',
          )}</td></tr>
      </tbody></table>
      <table><tbody><tr><td class="Label">*Workflow Due Date Offset</td><td>
        <input name="${N}tbWorkflowDueDateOffset" type="text" value="0" maxlength="5" id="${P}tbWorkflowDueDateOffset">
      </td></tr></tbody></table>
      <table><tbody>
        <tr><td class="Label">Work Day Start Time</td><td>${hours('7:00 am', 'StartTime', opts.startTimeHidden ? 'display:none;' : 'display:;')}</td></tr>
        <tr><td class="Label">Work Day End Time</td><td>${hours('3:00 pm', 'EndTime', 'display:;')}</td></tr>
        <tr><td class="Label">Work Week</td><td><table id="${P}chkWorkWeek"><tbody>${days
          .map(
            (d, i) =>
              `<tr><td><input id="${P}chkWorkWeek_${i}" type="checkbox" name="${N}chkWorkWeek$${i}"${i >= 1 && i <= 5 ? ' checked' : ''}><label for="${P}chkWorkWeek_${i}">${d}</label></td></tr>`,
          )
          .join('')}</tbody></table>
          <span id="${P}valWorkWeek" style="color:Red;display:none;">Must select at least one working day.</span>
        </td></tr>
      </tbody></table>
    </div>
    <script>
      window.planRoomCalls = 0;
      function setPlanRoomRowVisibility() { window.planRoomCalls++; }
    </script>
  </form></body></html>`;
}

describe('Project settings parsing (src/lib/eb-puppetmaster/project-settings.ts)', () => {
  it('normalizes whole-hour times to the page option format', () => {
    assert.strictEqual(normalizeWorkTime('7'), '7:00 am');
    assert.strictEqual(normalizeWorkTime('7am'), '7:00 am');
    assert.strictEqual(normalizeWorkTime('07:00 AM'), '7:00 am');
    assert.strictEqual(normalizeWorkTime('3:00 pm'), '3:00 pm');
    assert.strictEqual(normalizeWorkTime('15:00'), '3:00 pm');
    assert.strictEqual(normalizeWorkTime('0'), '12:00 am');
    assert.strictEqual(normalizeWorkTime('12pm'), '12:00 pm');
    assert.strictEqual(normalizeWorkTime('12 a.m.'), '12:00 am');
    assert.strictEqual(normalizeWorkTime('noon'), '12:00 pm');
    assert.throws(() => normalizeWorkTime('7:30 am'), /whole hours/);
    assert.throws(() => normalizeWorkTime('13pm'), /Invalid time/);
    assert.throws(() => normalizeWorkTime('25'), /Invalid time/);
    assert.throws(() => normalizeWorkTime('soon'), /Invalid time/);
  });

  it('parses work weeks as lists, ranges and keywords, Sunday first', () => {
    assert.deepStrictEqual(parseWorkWeek('fri, mon,Wednesday'), ['mon', 'wed', 'fri']);
    assert.deepStrictEqual(parseWorkWeek('mon-fri'), ['mon', 'tue', 'wed', 'thu', 'fri']);
    assert.deepStrictEqual(parseWorkWeek('weekdays sat'), [
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
    ]);
    assert.deepStrictEqual(parseWorkWeek('all').length, 7);
    assert.throws(() => parseWorkWeek('  '), /at least one day/);
    assert.throws(() => parseWorkWeek('mon,funday'), /Unknown day "funday"/);
    assert.throws(() => parseWorkWeek('fri-mon'), /Sunday→Saturday/);
  });

  it('parses raw inputs, skipping blanks and reporting every problem at once', () => {
    assert.deepStrictEqual(
      parseProjectSettingsInput({
        projectAccess: 'Hidden',
        denyTechsupport: 'no',
        documentControl: 'TRUE',
        workflowDueDateOffset: ' 3 ',
        workDayStart: '8am',
        workDayEnd: '',
        workWeek: undefined,
      }),
      {
        projectAccess: 'hidden',
        denyTechsupport: false,
        documentControl: true,
        workflowDueDateOffset: 3,
        workDayStart: '8:00 am',
      },
    );
    assert.throws(
      () =>
        parseProjectSettingsInput({
          projectAccess: 'secret',
          workflowDueDateOffset: '2.5',
          denyTechsupport: 'maybe',
        }),
      (e: any) =>
        /visible or hidden/.test(e.message) &&
        /whole number/.test(e.message) &&
        /yes or no/.test(e.message),
    );
  });

  it('diffs only requested settings that differ', () => {
    const current = {
      projectAccess: 'visible' as const,
      workflowDueDateOffset: 0,
      workWeek: ['mon', 'tue'] as any,
    };
    assert.deepStrictEqual(
      diffProjectSettings(current, {
        projectAccess: 'visible',
        workflowDueDateOffset: 2,
        workWeek: ['mon', 'tue'],
      }),
      [{ setting: 'workflowDueDateOffset', from: 0, to: 2 }],
    );
    assert.deepStrictEqual(diffProjectSettings(current, { workWeek: ['mon'] }), [
      { setting: 'workWeek', from: ['mon', 'tue'], to: ['mon'] },
    ]);
  });

  it('validates the merged settings like the page does', () => {
    assert.deepStrictEqual(
      validateProjectSettings({ workDayStart: '7:00 am', workDayEnd: '7:00 am', workWeek: [] }),
      [
        'Work week must include at least one working day.',
        'Work day start and end time must be different.',
      ],
    );
    assert.deepStrictEqual(
      validateProjectSettings({ workDayStart: '7:00 am', workDayEnd: '3:00 pm' }),
      [],
    );
  });
});

describe('Project settings page operations', () => {
  let browser: puppeteer.Browser;
  let page: puppeteer.Page;

  before(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    await BrowserManager.getInstance().closeBrowser();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page && !page.isClosed()) await page.close().catch(() => {});
  });

  it('reads the settings from the (inactive) Settings tab', async () => {
    await page.setContent(settingsPage());
    const snap = await readProjectSettingsFromPage(page);
    assert.strictEqual(snap.projectName, 'RH - Fixture Project');
    assert.deepStrictEqual(snap.unavailable, []);
    assert.deepStrictEqual(snap.settings, {
      projectAccess: 'visible',
      denyTechsupport: false,
      documentControl: true,
      workflowDueDateOffset: 0,
      workDayStart: '7:00 am',
      workDayEnd: '3:00 pm',
      workWeek: ['mon', 'tue', 'wed', 'thu', 'fri'],
    });
  });

  it('reports hidden rows and hidden selects as unavailable', async () => {
    await page.setContent(settingsPage({ docControlRowHidden: true, startTimeHidden: true }));
    const snap = await readProjectSettingsFromPage(page);
    assert.deepStrictEqual(snap.unavailable.sort(), ['documentControl', 'workDayStart']);
    assert.strictEqual(snap.settings.documentControl, undefined);
    assert.strictEqual(snap.settings.workDayEnd, '3:00 pm');
  });

  it('applies an update, runs page handlers and flags SettingsModified', async () => {
    await page.setContent(settingsPage());
    await applyProjectSettingsOnPage(page, {
      projectAccess: 'hidden',
      denyTechsupport: true,
      documentControl: false,
      workflowDueDateOffset: 5,
      workDayStart: '8:00 am',
      workDayEnd: '4:00 pm',
      workWeek: ['sun', 'sat'],
    });
    const snap = await readProjectSettingsFromPage(page);
    assert.deepStrictEqual(snap.settings, {
      projectAccess: 'hidden',
      denyTechsupport: true,
      documentControl: false,
      workflowDueDateOffset: 5,
      workDayStart: '8:00 am',
      workDayEnd: '4:00 pm',
      workWeek: ['sun', 'sat'],
    });
    const state = await page.evaluate(
      (p) => ({
        settingsModified: (document.getElementById(p + 'SettingsModified') as HTMLInputElement)
          .value,
        customModified: (document.getElementById(p + 'CustomFieldModified') as HTMLInputElement)
          .value,
        planRoomCalls: (window as any).planRoomCalls,
        accessChecked: Array.from(
          document.querySelectorAll<HTMLInputElement>(`input[name$="rblAllowUserLogins"]`),
        ).map((i) => i.checked),
      }),
      P,
    );
    assert.deepStrictEqual(state, {
      settingsModified: 'true',
      customModified: 'false',
      planRoomCalls: 1,
      accessChecked: [false, true],
    });
  });

  it('leaves untouched settings alone', async () => {
    await page.setContent(settingsPage());
    await applyProjectSettingsOnPage(page, { workflowDueDateOffset: 2 });
    const snap = await readProjectSettingsFromPage(page);
    assert.strictEqual(snap.settings.workflowDueDateOffset, 2);
    assert.strictEqual(snap.settings.projectAccess, 'visible');
    assert.deepStrictEqual(snap.settings.workWeek, ['mon', 'tue', 'wed', 'thu', 'fri']);
  });

  it('rejects a time that is not an option', async () => {
    await page.setContent(settingsPage());
    await assert.rejects(
      applyProjectSettingsOnPage(page, { workDayStart: '7:30 am' }),
      /"7:30 am" is not an option for StartTime/,
    );
  });

  it('collects visible validator messages after a failed save', async () => {
    await page.setContent(
      `<div><span id="${P}valEndTime" style="color:Red;">Work day start and end time must be different.</span>
       <span id="${P}valWorkWeek" style="display:none">Must select at least one working day.</span></div>`,
    );
    assert.deepStrictEqual(await readProjectSaveErrors(page), [
      'Work day start and end time must be different.',
    ]);
  });
});
