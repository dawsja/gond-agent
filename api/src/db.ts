import { hasServiceGithubCredentials } from "./github-credentials";
import { isLocalProfilePhoto } from "../../shared/profile-photo";
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
    CREATE TABLE IF NOT EXISTS mcp_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
    CREATE INDEX IF NOT EXISTS mcp_tokens_owner ON mcp_tokens(user_id);
    CREATE TABLE IF NOT EXISTS mcp_requests (token_id TEXT NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL, result TEXT, PRIMARY KEY(token_id,request_id));
    CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, auto_pr INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS user_accents (user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, accent TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_photos (user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, revision TEXT NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runs_owner_time ON runs(user_id,created_at);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id,seq);
    CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, media_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS occurrences (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, run_id TEXT, model_id TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cost_micros INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subscription_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, client_id TEXT NOT NULL, credentials TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, plan TEXT NOT NULL, limited_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS subscription_accounts_owner ON subscription_accounts(user_id,provider);
    CREATE TABLE IF NOT EXISTS subscription_notices (user_id TEXT PRIMARY KEY, welcomed_at INTEGER NOT NULL);
  `);
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS github_connections (user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE, token TEXT NOT NULL, login TEXT, connected_at INTEGER NOT NULL)`);
    db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('github-shared-fallback',?)").run(JSON.stringify(!!(getSetting(db, "github") || hasServiceGithubCredentials(process.env))));
  })();
  clearExternalProfileImages(db);
  retireCodingAgents(db);
  // Additive and idempotent: automatic CI rounds survive restarts and follow-ups.
  db.prepare("UPDATE runs SET data=json_set(data,'$.ci_round',0) WHERE json_extract(data,'$.backend')='builtin' AND json_type(data,'$.ci_round') IS NULL").run();
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
export function clearExternalProfileImages(db: Database.Database) {
  if (!(db.pragma('table_info("user")') as { name: string }[]).some(column => column.name === "image")) return 0;
  const cleared = db.transaction(() => {
    const rows = db.prepare('SELECT id,image FROM "user" WHERE image IS NOT NULL').all() as { id: string; image: string }[];
    const clear = db.prepare('UPDATE "user" SET image=NULL WHERE id=?');
    let count = 0;
    for (const row of rows) if (!isLocalProfilePhoto(row.image)) count += clear.run(row.id).changes;
    return count;
  })();
  if (cleared) console.log(`Cleared ${cleared} external profile image URLs.`);
  return cleared;
}
/**
 * Claude Code and Codex agents were removed in favour of the built-in runner. Idempotently delete
 * their sealed credentials, session state and runtime records, keep their run history readable,
 * and record pinned runtime volumes for label-scoped Docker cleanup at startup.
 */
export function retireCodingAgents(db: Database.Database) {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name));
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const removed: string[] = [];
  const secure = db.pragma("secure_delete", { simple: true });
  db.pragma("secure_delete = ON");
  try { db.transaction(() => {
    if (tables.has("cli_usage")) {
      // Token counts stay in usage history; subscription usage was never billed by Gond Agent.
      db.exec(`INSERT INTO usage(user_id,run_id,model_id,input,output,cache_read,cost_micros,created_at)
        SELECT user_id,run_id,model_id,coalesce(json_extract(data,'$.input_uncached'),0),coalesce(json_extract(data,'$.output'),0),coalesce(json_extract(data,'$.cache_read'),0),0,created_at FROM cli_usage`);
    }
    if (tables.has("cli_accounts")) removed.push(`${count("SELECT count(*) AS n FROM cli_accounts")} coding-agent sign-ins`);
    if (tables.has("cli_sessions")) removed.push(`${count("SELECT count(*) AS n FROM cli_sessions")} saved coding-agent sessions`);
    if ([...tables].some(t => t.startsWith("cli_"))) {
      db.exec("DROP TRIGGER IF EXISTS gond_agent_delete_account");
      // Overwrite sealed credentials and session state on disk instead of only unlinking their pages.
      for (const table of ["cli_sessions", "cli_accounts"]) if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
      for (const table of ["cli_sessions", "cli_accounts", "cli_usage_totals", "cli_usage"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    const settings = db.prepare("SELECT key,value FROM settings WHERE key='runtime-instance' OR key GLOB 'runtime:*' OR key GLOB 'runtime-history:*' OR key GLOB 'runtime-staging:*'").all() as { key: string; value: string }[];
    if (settings.length) {
      const cleanup = getSetting<{ instance?: string; volumes: string[] }>(db, "retired-runtime-cleanup") ?? { volumes: [] };
      for (const { key, value } of settings) {
        const parsed = JSON.parse(value) as unknown;
        if (key === "runtime-instance" && typeof parsed === "string") cleanup.instance = parsed;
        const names = key.startsWith("runtime:") ? [(parsed as { volume?: unknown })?.volume] : Array.isArray(parsed) ? parsed : [parsed];
        if (key !== "runtime-instance") for (const name of names) if (typeof name === "string" && !cleanup.volumes.includes(name)) cleanup.volumes.push(name);
      }
      setSetting(db, "retired-runtime-cleanup", cleanup);
      db.prepare("DELETE FROM settings WHERE key='runtime-instance' OR key GLOB 'runtime:*' OR key GLOB 'runtime-history:*' OR key GLOB 'runtime-staging:*'").run();
      removed.push(`${settings.filter(s => s.key.startsWith("runtime:")).length} runtime installations`);
    }
    const runs = db.prepare(`UPDATE runs SET data=json_set(json_remove(data,'$.runtime_volume','$.runtime_version','$.backend'),'$.backend','builtin','$.retired_backend',json_extract(data,'$.backend'),'$.pending',json('[]'))
      WHERE json_extract(data,'$.backend') IS NOT NULL AND json_extract(data,'$.backend')<>'builtin'`).run().changes;
    if (runs) removed.push(`follow-ups for ${runs} coding-agent runs (history kept)`);
    const schedules = db.prepare(`UPDATE runners SET enabled=0,data=json_set(data,'$.enabled',json('false'),'$.next_run_at',json('null'))
      WHERE enabled=1 AND json_extract(data,'$.model_id') GLOB 'cli-*'`).run().changes;
    if (schedules) removed.push(`${schedules} schedules that used coding-agent models (paused)`);
  })(); } finally { db.pragma(`secure_delete = ${secure ? "ON" : "OFF"}`); }
  if (removed.length) console.log(`Retired Claude Code and Codex agents: ${removed.join("; ")}.`);
  return removed;
}
// Better Auth creates the user table at startup. Install this afterwards so its
// deletion and our account data cleanup are one atomic SQLite operation.
export function installAccountCleanup(db: Store) {
  db.exec(`DROP TRIGGER IF EXISTS gond_agent_delete_account;
  CREATE TRIGGER gond_agent_delete_account AFTER DELETE ON "user" BEGIN
    DELETE FROM occurrences WHERE EXISTS (SELECT 1 FROM runners r WHERE r.user_id=OLD.id AND occurrences.key GLOB 'schedule:' || r.id || ':*');
    DELETE FROM runners WHERE user_id=OLD.id;
    DELETE FROM subscription_accounts WHERE user_id=OLD.id;
    DELETE FROM subscription_notices WHERE user_id=OLD.id;
    DELETE FROM usage WHERE user_id=OLD.id;
    DELETE FROM images WHERE user_id=OLD.id;
    DELETE FROM runs WHERE user_id=OLD.id;
    DELETE FROM github_connections WHERE user_id=OLD.id;
    DELETE FROM profiles WHERE user_id=OLD.id;
    DELETE FROM administrators WHERE user_id=OLD.id;
    DELETE FROM settings WHERE key IN ('providers','oidc','github','github-shared-fallback','web-search') AND NOT EXISTS (SELECT 1 FROM "user");
    DELETE FROM occurrences WHERE NOT EXISTS (SELECT 1 FROM "user");
  END`);
}
export function getSetting<T>(db: Store | Database.Database, key: string): T | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}
export function setSetting(db: Store | Database.Database, key: string, value: unknown) {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
}
