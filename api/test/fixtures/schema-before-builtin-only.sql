-- Schema written by the release before the built-in-only change (api/src/db.ts at 53c56ad),
-- including the Claude Code/Codex tables and the account cleanup trigger. Used by migration tests.
CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT);
CREATE TABLE IF NOT EXISTS administrators (user_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS mcp_tokens_owner ON mcp_tokens(user_id);
CREATE TABLE IF NOT EXISTS mcp_requests (token_id TEXT NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT NOT NULL, result TEXT, PRIMARY KEY(token_id,request_id));
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
END
