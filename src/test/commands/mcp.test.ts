import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as db from '../../lib/db.js';
import McpCommand from '../../commands/mcp.js';

describe('MCP Server Command (src/commands/mcp.ts)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-cmd-mcp-test-'));
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

  it('declares MCP command metadata and description', () => {
    assert.strictEqual(
      McpCommand.description,
      'Start an MCP (Model Context Protocol) stdio server exposing e-Builder automation tools to AI agents',
    );
    assert.ok(McpCommand.examples && McpCommand.examples.length > 0);
  });
});
