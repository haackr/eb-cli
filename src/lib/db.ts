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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
createTables();

const insertSession = db.prepare(`
    INSERT INTO sessions (username, environment, account, session_cookies) VALUES (?, ?, ?, ?)
  `);

export function addSession(
  username: string,
  environment: string,
  account: string,
  session_cookies: string
) {
  insertSession.run(username, environment, account, session_cookies);
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
  resetSequenceIfEmpty();
}

const deleteUserSessions = db.prepare(
  "DELETE FROM sessions WHERE username = ?"
);
export function deleteSessionsByUsername(username: string) {
  deleteUserSessions.run(username);
  resetSequenceIfEmpty();
}

const dbupdateSessionById = db.prepare(
  `UPDATE sessions SET username = ?, environment = ?, account = ?, session_cookies = ? WHERE id = ?`
);
export function updateSessionById(
  id: number,
  username: string,
  environment: string,
  account: string,
  session_cookies: string
) {
  dbupdateSessionById.run(username, environment, account, session_cookies, id);
}

function resetSequenceIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as {
    count: number;
  };
  if (count.count === 0) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name='sessions'").run();
  }
}
