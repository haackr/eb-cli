import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ProjectSettingsSet from '../../commands/project/settings/set.js';

describe('Project settings commands (src/commands/project/settings/)', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cmd-ps-test-'));
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires at least one setting', async () => {
    await assert.rejects(ProjectSettingsSet.run(['Some Project']), /Pass at least one setting/);
  });

  it('requires a project or --file', async () => {
    await assert.rejects(ProjectSettingsSet.run(['--access', 'hidden']), /Pass a project/);
  });

  it('rejects invalid values before opening a browser', async () => {
    await assert.rejects(
      ProjectSettingsSet.run(['Some Project', '--work-start', '7:30am', '--due-date-offset', 'x']),
      (e: any) => /whole hours/.test(e.message) && /whole number/.test(e.message),
    );
  });

  it('rejects a project argument together with --file', async () => {
    const csv = path.join(tmpDir, 'both.csv');
    fs.writeFileSync(csv, 'project,access\nA,hidden\n');
    await assert.rejects(
      ProjectSettingsSet.run(['Some Project', '--file', csv]),
      /either a project or --file/,
    );
  });

  it('validates every CSV row (with header aliases) before doing any work', async () => {
    const csv = path.join(tmpDir, 'bad.csv');
    fs.writeFileSync(
      csv,
      [
        'Project Name,Project Access,Work Week,Start Time',
        'Good Project,hidden,mon-fri,7am',
        ',visible,,',
        'Bad Values,secret,funday,',
        'Empty Row,,,',
      ].join('\n'),
    );
    await assert.rejects(ProjectSettingsSet.run(['--file', csv]), (e: any) => {
      assert.match(e.message, /Row 3: missing project/);
      assert.match(e.message, /Row 4 \(Bad Values\): .*visible or hidden.*Unknown day "funday"/);
      assert.match(e.message, /Row 5 \(Empty Row\): no settings given/);
      assert.doesNotMatch(e.message, /Row 2/);
      return true;
    });
  });

  it('reports a missing CSV file', async () => {
    await assert.rejects(
      ProjectSettingsSet.run(['--file', path.join(tmpDir, 'nope.csv')]),
      /File not found/,
    );
  });
});
