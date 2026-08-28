import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initDb,
  closeDb,
  addSession,
  getSessions,
  getSessionsByUsername,
  getSessionById,
  updateSessionById,
  updateSessionCookies,
  deleteSessionById,
  deleteSessionsByUsername,
  resetSequenceIfEmpty,
} from '../lib/db.js';

describe('Database Operations (src/lib/db.ts)', () => {
  let tmpDir: string;
  let testDbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-cli-test-db-'));
    testDbPath = path.join(tmpDir, 'test.db');
    initDb(testDbPath);
  });

  after(() => {
    closeDb();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('initializes an empty sessions table', () => {
    const sessions = getSessions();
    assert.deepStrictEqual(sessions, []);
  });

  it('adds and retrieves sessions', () => {
    addSession(
      'user1@example.com',
      'us1',
      'AccountA',
      JSON.stringify([{ name: 'cookie1', value: 'v1' }]),
    );
    addSession(
      'user2@example.com',
      'us2',
      'AccountB',
      JSON.stringify([{ name: 'cookie2', value: 'v2' }]),
    );

    const sessions = getSessions();
    assert.strictEqual(sessions.length, 2);
    assert.strictEqual(sessions[0]?.id, 1);
    assert.strictEqual(sessions[0]?.username, 'user1@example.com');
    assert.strictEqual(sessions[0]?.environment, 'us1');
    assert.strictEqual(sessions[0]?.account, 'AccountA');
    assert.strictEqual(
      sessions[0]?.session_cookies,
      JSON.stringify([{ name: 'cookie1', value: 'v1' }]),
    );
    assert.ok(sessions[0]?.created_at);

    assert.strictEqual(sessions[1]?.id, 2);
    assert.strictEqual(sessions[1]?.username, 'user2@example.com');
  });

  it('filters sessions by username', () => {
    addSession('john.doe@example.com', 'us1', 'Acct1', '[]');
    addSession('jane.doe@example.com', 'us1', 'Acct2', '[]');
    addSession('john.doe@example.com', 'us2', 'Acct3', '[]');

    const johnSessions = getSessionsByUsername('john.doe@example.com');
    assert.strictEqual(johnSessions.length, 2);
    assert.strictEqual(johnSessions[0]?.account, 'Acct1');
    assert.strictEqual(johnSessions[1]?.account, 'Acct3');

    const unknownSessions = getSessionsByUsername('nobody@example.com');
    assert.deepStrictEqual(unknownSessions, []);
  });

  it('retrieves session by id', () => {
    addSession('alice@example.com', 'gov', 'GovAcct', '[]');
    const session = getSessionById(1);
    assert.ok(session);
    assert.strictEqual(session.username, 'alice@example.com');
    assert.strictEqual(session.environment, 'gov');

    const notFound = getSessionById(999);
    assert.strictEqual(notFound, undefined);
  });

  it('updates session details by id', () => {
    addSession('bob@example.com', 'us1', 'OldAcct', '[]');
    updateSessionById(1, 'bob.new@example.com', 'ca', 'NewAcct', '[{"updated":true}]');

    const updated = getSessionById(1);
    assert.ok(updated);
    assert.strictEqual(updated.username, 'bob.new@example.com');
    assert.strictEqual(updated.environment, 'ca');
    assert.strictEqual(updated.account, 'NewAcct');
    assert.strictEqual(updated.session_cookies, '[{"updated":true}]');
  });

  it('updates only session cookies by id', () => {
    addSession('carol@example.com', 'us3', 'AcctX', '[]');
    updateSessionCookies(1, '[{"token":"abc"}]');

    const updated = getSessionById(1);
    assert.ok(updated);
    assert.strictEqual(updated.username, 'carol@example.com');
    assert.strictEqual(updated.session_cookies, '[{"token":"abc"}]');
  });

  it('deletes session by id and resets autoincrement sequence when table becomes empty', () => {
    addSession('userA@example.com', 'us1', 'Acct1', '[]');
    addSession('userB@example.com', 'us1', 'Acct2', '[]');

    deleteSessionById(1);
    let sessions = getSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0]?.id, 2);

    deleteSessionById(2);
    sessions = getSessions();
    assert.strictEqual(sessions.length, 0);

    // After deleting all sessions, the auto-increment sequence resets
    addSession('userC@example.com', 'us1', 'Acct3', '[]');
    const newSession = getSessions()[0];
    assert.strictEqual(newSession?.id, 1);
  });

  it('deletes sessions by username and resets sequence when empty', () => {
    addSession('target@example.com', 'us1', 'A1', '[]');
    addSession('target@example.com', 'us2', 'A2', '[]');
    addSession('keep@example.com', 'us3', 'A3', '[]');

    deleteSessionsByUsername('target@example.com');
    const remaining = getSessions();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0]?.username, 'keep@example.com');

    deleteSessionsByUsername('keep@example.com');
    assert.strictEqual(getSessions().length, 0);
  });

  it('resetSequenceIfEmpty does not throw when database is already empty', () => {
    assert.doesNotThrow(() => {
      resetSequenceIfEmpty();
    });
  });
});
