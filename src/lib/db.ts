import Database from "better-sqlite3";

const db = Database("eb.db");

export function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      environment TEXT,
      account TEXT,
      session_cookies TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at INTEGER
    );
  `);
  // Add expires_at column if it doesn't exist (for existing databases)
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN expires_at INTEGER;`);
  } catch (e) {
    // Column already exists or other error, ignore
  }
}
createTables();

const insertSession = db.prepare(`
    INSERT INTO sessions (username, environment, account, session_cookies, expires_at) VALUES (?, ?, ?, ?, ?)
  `);

export function addSession(
  username: string,
  environment: string,
  account: string,
  session_cookies: string,
  expiresAt: number | null = null
) {
  insertSession.run(username, environment, account, session_cookies, expiresAt);
}

const getAllSessions = db.prepare("SELECT * FROM sessions");
export function getSessions() {
  return getAllSessions.all();
}

const getUserSessions = db.prepare("SELECT * FROM sessions WHERE username = ?");
export function getSessionsByUsername(username: string) {
  return getUserSessions.all(username);
}

const getSessionByIdStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
export function getSessionById(id: number) {
  return getSessionByIdStmt.get(id);
}

const deleteSessionId = db.prepare("DELETE FROM sessions WHERE id = ?");
export function deleteSessionById(id: number) {
  deleteSessionId.run(id);
}

const deleteUserSessions = db.prepare(
  "DELETE FROM sessions WHERE username = ?"
);
export function deleteSessionsByUsername(username: string) {
  deleteUserSessions.run(username);
}

const dbupdateSessionById = db.prepare(
  `UPDATE sessions SET username = ?, environment = ?, account = ?, session_cookies = ?, expires_at = ? WHERE id = ?`
);
export function updateSessionById(
  id: number,
  username: string,
  environment: string,
  account: string,
  session_cookies: string,
  expiresAt: number | null = null
) {
  dbupdateSessionById.run(
    username,
    environment,
    account,
    session_cookies,
    expiresAt,
    id
  );
}
