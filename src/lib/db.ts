import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export type SessionRow = {
  id: number;
  username: string;
  environment: string;
  account: string;
  session_cookies: string;
  created_at: string;
};

export type CredentialRefRow = {
  id: number;
  session_id: number;
  provider: string;
  item_ref: string;
  vault?: string | null;
  created_at: string;
};

export type SchemaCacheRow = {
  id: number;
  environment: string;
  account: string;
  schema_type: string;
  entity_key: string;
  data_json: string;
  updated_at: string;
};

let db: Database.Database;
let insertSession: Database.Statement;
let getAllSessions: Database.Statement;
let getUserSessions: Database.Statement;
let getSessionByIdStmt: Database.Statement;
let deleteSessionId: Database.Statement;
let deleteUserSessions: Database.Statement;
let dbupdateSessionById: Database.Statement;
let updateSessionCookiesStmt: Database.Statement;

let getCachedSchemaStmt: Database.Statement;
let setCachedSchemaStmt: Database.Statement;
let clearCachedSchemaStmt: Database.Statement;

let getCredentialRefStmt: Database.Statement;
let setCredentialRefStmt: Database.Statement;
let deleteCredentialRefStmt: Database.Statement;

function getDbPath(): string {
  if (process.env['EB_CLI_DB_PATH']) {
    const customPath = process.env['EB_CLI_DB_PATH'];
    const customDir = path.dirname(customPath);
    if (!fs.existsSync(customDir)) {
      fs.mkdirSync(customDir, { recursive: true });
    }
    return customPath;
  }
  const dbDir = path.join(os.homedir(), '.eb-cli');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'eb.db');
}

function prepareStatements() {
  insertSession = db.prepare(`
    INSERT INTO sessions (username, environment, account, session_cookies) VALUES (?, ?, ?, ?)
  `);
  getAllSessions = db.prepare('SELECT * FROM sessions');
  getUserSessions = db.prepare('SELECT * FROM sessions WHERE username = ?');
  getSessionByIdStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  deleteSessionId = db.prepare('DELETE FROM sessions WHERE id = ?');
  deleteUserSessions = db.prepare('DELETE FROM sessions WHERE username = ?');
  dbupdateSessionById = db.prepare(
    `UPDATE sessions SET username = ?, environment = ?, account = ?, session_cookies = ? WHERE id = ?`,
  );
  updateSessionCookiesStmt = db.prepare(`UPDATE sessions SET session_cookies = ? WHERE id = ?`);

  getCachedSchemaStmt = db.prepare(`
    SELECT data_json FROM schema_cache 
    WHERE environment = ? AND account = ? AND schema_type = ? AND entity_key = ?
  `);
  setCachedSchemaStmt = db.prepare(`
    INSERT INTO schema_cache (environment, account, schema_type, entity_key, data_json, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(environment, account, schema_type, entity_key) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = CURRENT_TIMESTAMP
  `);
  clearCachedSchemaStmt = db.prepare(`
    DELETE FROM schema_cache
    WHERE environment = ? AND account = ? AND schema_type = ? AND entity_key = ?
  `);

  getCredentialRefStmt = db.prepare(`SELECT * FROM credential_refs WHERE session_id = ?`);
  setCredentialRefStmt = db.prepare(`
    INSERT INTO credential_refs (session_id, provider, item_ref, vault, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET
      provider = excluded.provider,
      item_ref = excluded.item_ref,
      vault = excluded.vault,
      created_at = CURRENT_TIMESTAMP
  `);
  deleteCredentialRefStmt = db.prepare(`DELETE FROM credential_refs WHERE session_id = ?`);
}

export function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      environment TEXT,
      account TEXT,
      session_cookies TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schema_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      environment TEXT NOT NULL,
      account TEXT NOT NULL,
      schema_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(environment, account, schema_type, entity_key)
    );

    CREATE TABLE IF NOT EXISTS credential_refs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER UNIQUE,
      provider TEXT NOT NULL,
      item_ref TEXT NOT NULL,
      vault TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

export function initDb(customPath?: string): Database.Database {
  if (db) {
    try {
      db.close();
    } catch {}
  }
  const targetPath = customPath || getDbPath();
  db = new Database(targetPath);
  createTables();
  prepareStatements();
  return db;
}

initDb();

export function addSession(
  username: string,
  environment: string,
  account: string,
  session_cookies: string,
) {
  insertSession.run(username, environment, account, session_cookies);
}

export function getSessions(): SessionRow[] {
  return getAllSessions.all() as SessionRow[];
}

export function getSessionsByUsername(username: string): SessionRow[] {
  return getUserSessions.all(username) as SessionRow[];
}

export function getSessionById(id: number): SessionRow | undefined {
  return getSessionByIdStmt.get(id) as SessionRow | undefined;
}

export function deleteSessionById(id: number) {
  deleteSessionId.run(id);
  resetSequenceIfEmpty();
}

export function deleteSessionsByUsername(username: string) {
  deleteUserSessions.run(username);
  resetSequenceIfEmpty();
}

export function updateSessionById(
  id: number,
  username: string,
  environment: string,
  account: string,
  session_cookies: string,
) {
  dbupdateSessionById.run(username, environment, account, session_cookies, id);
}

export function updateSessionCookies(id: number, session_cookies: string) {
  updateSessionCookiesStmt.run(session_cookies, id);
}

export function getCachedSchema(
  env: string,
  account: string,
  schemaType: string,
  entityKey: string,
): string | undefined {
  const row = getCachedSchemaStmt.get(env, account, schemaType, entityKey) as
    { data_json: string } | undefined;
  return row?.data_json;
}

export function setCachedSchema(
  env: string,
  account: string,
  schemaType: string,
  entityKey: string,
  dataJson: string,
): void {
  setCachedSchemaStmt.run(env, account, schemaType, entityKey, dataJson);
}

export function clearCachedSchema(
  env: string,
  account: string,
  schemaType: string,
  entityKey: string,
): void {
  clearCachedSchemaStmt.run(env, account, schemaType, entityKey);
}

export function getCredentialRef(sessionId: number): CredentialRefRow | undefined {
  return getCredentialRefStmt.get(sessionId) as CredentialRefRow | undefined;
}

export function setCredentialRef(
  sessionId: number,
  provider: string,
  itemRef: string,
  vault?: string,
): void {
  setCredentialRefStmt.run(sessionId, provider, itemRef, vault ?? null);
}

export function deleteCredentialRef(sessionId: number): void {
  deleteCredentialRefStmt.run(sessionId);
}

export function resetSequenceIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as {
    count: number;
  };
  if (count.count === 0) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name='sessions'").run();
  }
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {}
  }
}
