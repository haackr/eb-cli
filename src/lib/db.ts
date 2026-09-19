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

let db: Database.Database;
let insertSession: Database.Statement;
let getAllSessions: Database.Statement;
let getUserSessions: Database.Statement;
let getSessionByIdStmt: Database.Statement;
let deleteSessionId: Database.Statement;
let deleteUserSessions: Database.Statement;
let dbupdateSessionById: Database.Statement;
let updateSessionCookiesStmt: Database.Statement;

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
