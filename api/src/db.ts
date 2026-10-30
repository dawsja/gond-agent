import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
export type Store = ReturnType<typeof openStore>;
export function openStore(data: string) {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const db = new Database(join(data, "gond-agent.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS administrators (user_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, auto_pr INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS profile_photos (user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, revision TEXT NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runs_owner_time ON runs(user_id,created_at);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id,seq);
    CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, media_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS occurrences (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cli_usage_totals(key TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cli_usage(event_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,run_id TEXT NOT NULL,model_id TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cli_accounts (user_id TEXT NOT NULL, backend TEXT NOT NULL, credentials TEXT NOT NULL, connected_at INTEGER NOT NULL DEFAULT 0, models TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(user_id,backend));
    CREATE TABLE IF NOT EXISTS cli_sessions (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT, model_id TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cost_micros INTEGER NOT NULL, created_at INTEGER NOT NULL);

  `);
  if(!(db.pragma("table_info(cli_accounts)") as {name:string}[]).some(c=>c.name==="connected_at"))db.exec("ALTER TABLE cli_accounts ADD COLUMN connected_at INTEGER NOT NULL DEFAULT 0");
  // Retire the old catalog and keep only current profile preferences on upgrades.
  db.transaction(() => {
    db.prepare("UPDATE settings SET value=json_remove(value,'$.transcription') WHERE key='providers' AND json_valid(value) AND json_type(value,'$.transcription') IS NOT NULL").run();
    db.exec("DROP TABLE IF EXISTS models");
    const allowed = new Set(["user_id", "auto_pr"]);
    for (const { name } of db.pragma("table_info(profiles)") as { name: string }[])
      if (!allowed.has(name)) db.exec(`ALTER TABLE profiles DROP COLUMN "${name.replace(/"/g, '\"\"')}"`);
  })();
  return db;
}
// Better Auth creates the user table at startup. Install this afterwards so its
// deletion and our account data cleanup are one atomic SQLite operation.
export function installAccountCleanup(db: Store) {
  db.exec(`DROP TRIGGER IF EXISTS gond_agent_delete_account;
  CREATE TRIGGER gond_agent_delete_account AFTER DELETE ON "user" BEGIN
    DELETE FROM occurrences WHERE EXISTS (SELECT 1 FROM runners r WHERE r.user_id=OLD.id AND occurrences.key GLOB 'schedule:' || r.id || ':*');
    DELETE FROM runners WHERE user_id=OLD.id;
    DELETE FROM cli_usage WHERE user_id=OLD.id;
    DELETE FROM cli_accounts WHERE user_id=OLD.id;
    DELETE FROM usage WHERE user_id=OLD.id;
    DELETE FROM images WHERE user_id=OLD.id;
    DELETE FROM runs WHERE user_id=OLD.id;
    DELETE FROM profiles WHERE user_id=OLD.id;
    DELETE FROM administrators WHERE user_id=OLD.id;
    DELETE FROM settings WHERE key IN ('providers','oidc','github') AND NOT EXISTS (SELECT 1 FROM "user");
    DELETE FROM occurrences WHERE NOT EXISTS (SELECT 1 FROM "user");
  END`);
}
export function getSetting<T>(db: Store, key: string): T | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}
export function setSetting(db: Store, key: string, value: unknown) {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
}
