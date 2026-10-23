import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as db from '../../lib/db.js';
import {
  saveCachedProcessSchema,
  getCachedProcessSchema,
  type ProcessSchema,
} from '../../lib/eb-puppetmaster/process-schema.js';
import ProcessInspect from '../../commands/process/inspect.js';

describe('Process Schema & Caching (src/lib/eb-puppetmaster/process-schema.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-proc-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    db.initDb(testDbPath);
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  after(() => {
    db.closeDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('saves and retrieves process schema from local SQLite cache', () => {
    const mockSchema: ProcessSchema = {
      name: 'Commitment Change Order',
      processTypeId: 'proc-101',
      prefix: 'CCO',
      description: 'Test change order process',
      workflowSteps: [
        { id: 's1', name: 'Draft', type: 'Start', actions: ['Submit'] },
        { id: 's2', name: 'Review', type: 'Review', actions: ['Approve', 'Reject'] },
      ],
      dataFields: [
        { id: 'df1', name: 'Scope', type: 'TextArea', required: true },
        {
          id: 'df2',
          name: 'Reason',
          type: 'DropDown',
          required: true,
          options: ['Owner', 'Field'],
        },
      ],
      layoutMatrix: {
        Draft: { Scope: 'required', Reason: 'required' },
        Review: { Scope: 'readonly', Reason: 'readonly' },
      },
    };

    saveCachedProcessSchema('us1', 'Capital Division', 'Commitment Change Order', mockSchema);

    const retrieved = getCachedProcessSchema('us1', 'Capital Division', 'Commitment Change Order');
    assert.ok(retrieved);
    assert.strictEqual(retrieved.name, 'Commitment Change Order');
    assert.strictEqual(retrieved.processTypeId, 'proc-101');
    assert.strictEqual(retrieved.dataFields.length, 2);
    assert.strictEqual(retrieved.workflowSteps.length, 2);
    assert.strictEqual(retrieved.layoutMatrix['Draft']?.['Scope'], 'required');
    assert.ok(retrieved.cachedAt);
  });

  it('ProcessInspect command returns cached schema instantly with --cached and --json', async () => {
    db.addSession('alice@example.com', 'us1', 'Acct1', '[]');
    const cachedData: ProcessSchema = {
      name: 'Invoice',
      processTypeId: 'inv-99',
      workflowSteps: [],
      dataFields: [{ name: 'Amount', type: 'Currency', required: true }],
      layoutMatrix: {},
    };
    saveCachedProcessSchema('us1', 'Acct1', 'Invoice', cachedData);

    const result: any = await ProcessInspect.run(['Invoice', '--cached', '--json']);

    assert.ok(result);
    assert.strictEqual(result.name, 'Invoice');
    assert.strictEqual(result.dataFields[0].name, 'Amount');
  });
});
