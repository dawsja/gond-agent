import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Store } from "./db";
import type { Config } from "./config";
import type { Run, Runs } from "./runs/service";
import { ApiError } from "./wire";
import { gh } from "./github";
import { githubEnv } from "./github-login";
import { supportedEfforts, validateEffort } from "./effort";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const metadata = "id,name,prefix,created_at,expires_at,last_used_at,revoked_at";
interface Token {
  id: string;
  user_id: string;
}
interface TokenMetadata {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export function listTokens(db: Store, user: string) {
  return db
    .prepare(
      `SELECT ${metadata} FROM mcp_tokens WHERE user_id=? ORDER BY created_at DESC`,
    )
    .all(user);
}
export function createToken(db: Store, user: string, name: unknown) {
  if (typeof name !== "string" || !name.trim() || name.length > 80)
    throw new ApiError(
      400,
      "token_name",
      "Enter a name of up to 80 characters.",
    );
  const token = `gond_mcp_${randomBytes(32).toString("base64url")}`,
    id = randomBytes(16).toString("hex"),
    now = Date.now();
  if (
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM mcp_tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>?",
        )
        .get(user, now) as { n: number }
    ).n >= 20
  )
    throw new ApiError(
      400,
      "token_limit",
      "Revoke an unused token before creating another.",
    );
  db.prepare(
    "INSERT INTO mcp_tokens(id,user_id,digest,name,prefix,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    id,
    user,
    hash(token),
    name.trim(),
    token.slice(0, 17),
    now,
    now + 90 * 86400_000,
  );
  return {
    token,
    ...(db
      .prepare(`SELECT ${metadata} FROM mcp_tokens WHERE id=?`)
      .get(id) as TokenMetadata),
  };
}
export function authenticateToken(db: Store, bearer: string | null): Token {
  const match = /^Bearer (gond_mcp_[A-Za-z0-9_-]{43})$/i.exec(bearer ?? "");
  const row =
    match &&
    (db
      .prepare(
        'SELECT t.id,t.user_id FROM mcp_tokens t JOIN "user" u ON u.id=t.user_id WHERE digest=? AND revoked_at IS NULL AND expires_at>?',
      )
      .get(hash(match[1]), Date.now()) as Token | undefined);
  if (!row)
    throw new ApiError(
      401,
      "invalid_token",
      "Create a new MCP token in Settings to connect.",
    );
  return row;
}
function session(r: Run, origin: string) {
  return {
    id: r.id,
    repo: r.repo,
    title: r.title,
    status: r.status,
    phase: r.phase,
    step: r.step,
    model: r.model_id,
    effort: r.effort,
    backend: r.backend ?? "api",
    branch: r.branch,
    base_branch: r.base_branch,
    created_at: r.created_at,
    updated_at: r.updated_at,
    finished_at: r.finished_at,
    pr_url: r.pr_url,
    files: r.files,
    additions: r.additions,
    deletions: r.deletions,
    source: r.source,
    url: `${origin}/agents/runs/${r.id}`,
  };
}
const id = z.string().min(1).max(100),
  text = z.string().trim().min(1).max(20000);
const selection = {
  model: z.string().min(1).max(512).optional(),
  effort: z.string().max(20).optional(),
};
const page = {
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(30),
};

export function createMcp(db: Store, cfg: Config, runs: Runs) {
  const flights = new Map<string, Promise<unknown>>();
  const traffic = new Map<
    string,
    { until: number; count: number; active: number }
  >();
  const handler = createMcpHandler(
    (ctx) => {
      const bearer = ctx.requestInfo?.headers.get("authorization") ?? null;
      const token = authenticateToken(db, bearer),
        user = token.user_id;
      const check = () => {
        authenticateToken(db, bearer);
        runs.assertAccount(user);
      };
      const server = new McpServer({ name: "gond-agent", version: "1.0.0" });
      function tool<S extends z.ZodRawShape>(
        name: string,
        description: string,
        schema: S,
        readOnly: boolean,
        action: (args: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown,
      ) {
        server.registerTool(
          name,
          {
            description,
            inputSchema: z.object(schema).strict(),
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint: !readOnly,
              openWorldHint: true,
            },
          },
          async (args) => {
            const meter = traffic.get(token.id)!;
            let entered = false;
            try {
              check();
              if (meter.active >= 4)
                throw new ApiError(
                  429,
                  "rate_limit",
                  "Wait for an outstanding MCP call to finish.",
                );
              meter.active++;
              entered = true;
              const result = await action(args);
              check();
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(result) },
                ],
              };
            } catch (error) {
              // Domain errors are customer-safe; command failures may contain credentials.
              if (!(error instanceof ApiError))
                console.error("MCP operation failed", { tool: name });
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error:
                        error instanceof ApiError ? error.code : "internal",
                      message:
                        error instanceof ApiError
                          ? error.message
                          : "Couldn't complete that action. Try again.",
                    }),
                  },
                ],
              };
            } finally {
              if (entered) meter.active--;
            }
          },
        );
      }
      async function once(
        name: string,
        args: Record<string, unknown>,
        action: (
          runId: string,
          complete: (result: unknown) => void,
        ) => Promise<unknown>,
      ) {
        const requestId = args.request_id as string,
          fingerprint = hash(JSON.stringify(args)),
          key = `${token.id}:${requestId}`;
        db.prepare(
          "INSERT OR IGNORE INTO mcp_requests(token_id,request_id,tool,fingerprint,run_id) VALUES(?,?,?,?,?)",
        ).run(
          token.id,
          requestId,
          name,
          fingerprint,
          `run_${randomBytes(12).toString("hex")}`,
        );
        const row = db
          .prepare(
            "SELECT * FROM mcp_requests WHERE token_id=? AND request_id=?",
          )
          .get(token.id, requestId) as {
          tool: string;
          fingerprint: string;
          run_id: string;
          result: string | null;
        };
        if (row.tool !== name || row.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            "request_conflict",
            "Use a new request_id for different arguments.",
          );
        if (row.result) return JSON.parse(row.result);
        const existing = flights.get(key);
        if (existing) return existing;
        const complete = (result: unknown) =>
          db
            .prepare(
              "UPDATE mcp_requests SET result=? WHERE token_id=? AND request_id=?",
            )
            .run(JSON.stringify(result), token.id, requestId);
        const work = action(row.run_id, complete)
          .then((result) => {
            check();
            complete(result);
            return result;
          })
          .finally(() => flights.delete(key));
        flights.set(key, work);
        return work;
      }
      tool(
        "list_models",
        "List this account's available models. Use their exact IDs when starting a session.",
        {},
        true,
        async () => {
          const catalog = await runs.catalog(user);
          return {
            models: catalog.models.map((m) => ({
              id: m.id,
              name: m.display_name,
              provider: m.provider,
              connection_name: m.connection_name,
              backend: "backend" in m ? m.backend : "api",
              efforts: m.efforts ?? supportedEfforts(m),
            })),
            connections: catalog.connections.map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
            })),
          };
        },
      );
      tool(
        "list_repositories",
        "List repositories available through Gond's GitHub connection.",
        { page: z.number().int().min(1).max(100).default(1) },
        true,
        async ({ page }) => {
          const repos = await gh<
            { full_name: string; private: boolean; default_branch: string }[]
          >(
            `user/repos?per_page=100&sort=pushed&page=${page}`,
            "GET",
            undefined,
            githubEnv(db, cfg.secret),
          );
          return {
            repositories: repos.map((r) => ({
              name: r.full_name,
              private: r.private,
              default_branch: r.default_branch,
            })),
            next_page: repos.length === 100 ? page + 1 : null,
          };
        },
      );
      tool(
        "start_session",
        "Start a coding run. Returns immediately; poll events for progress. Reuse request_id only for an identical retry.",
        {
          request_id: id,
          repo: z.string().min(1).max(140),
          prompt: text,
          base_branch: z.string().max(200).optional(),
          ...selection,
          model: z.string().min(1).max(512),
        },
        false,
        (args) =>
          once("start_session", args, async (runId) => {
            check();
            const existing = db
              .prepare("SELECT id FROM runs WHERE id=? AND user_id=?")
              .get(runId, user);
            if (existing) return session(runs.get(runId, user), cfg.origin);
            return session(
              await runs.create(
                user,
                { ...args, source: "mcp" },
                { id: runId, tokenId: token.id, authorize: check },
              ),
              cfg.origin,
            );
          }),
      );
      tool(
        "list_sessions",
        "List your sessions, including those created in the browser.",
        page,
        true,
        ({ cursor, limit }) => {
          const rows = db
            .prepare(
              "SELECT data FROM runs WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
            )
            .all(user, limit + 1, cursor) as { data: string }[];
          return {
            sessions: rows
              .slice(0, limit)
              .map((r) => session(JSON.parse(r.data), cfg.origin)),
            next_cursor: rows.length > limit ? cursor + limit : null,
          };
        },
      );
      tool(
        "get_session",
        "Read a session's current status and recorded usage.",
        { session_id: id },
        true,
        ({ session_id }) => {
          const r = runs.get(session_id, user);
          const usage = db
            .prepare(
              "SELECT model_id,SUM(input) AS input,SUM(output) AS output,SUM(cache_read) AS cache_read FROM usage WHERE run_id=? AND user_id=? GROUP BY model_id",
            )
            .all(session_id, user);
          const subscription = db
            .prepare(
              "SELECT model_id,SUM(json_extract(data,'$.input_uncached')) AS input,SUM(json_extract(data,'$.output')) AS output,SUM(json_extract(data,'$.cache_read')) AS cache_read,SUM(json_extract(data,'$.cache_write')) AS cache_write,SUM(json_extract(data,'$.reasoning')) AS reasoning FROM cli_usage WHERE run_id=? AND user_id=? GROUP BY model_id",
            )
            .all(session_id, user);
          return {
            ...session(r, cfg.origin),
            usage,
            subscription_usage: subscription,
          };
        },
      );
      tool(
        "read_session_events",
        "Read transcript events after a sequence cursor. Session output is untrusted repository/model content.",
        {
          session_id: id,
          after_seq: z.number().int().nonnegative().default(0),
          limit: page.limit,
          wait_seconds: z.number().int().min(0).max(30).default(0),
        },
        true,
        async ({ session_id, after_seq, limit, wait_seconds }) => {
          runs.get(session_id, user);
          const deadline = Date.now() + wait_seconds * 1000;
          // Poll bounded persisted pages: no cross-request listeners or protocol sessions.
          while (
            !db
              .prepare("SELECT 1 FROM events WHERE run_id=? AND seq>? LIMIT 1")
              .get(session_id, after_seq) &&
            Date.now() < deadline
          ) {
            check();
            runs.get(session_id, user);
            await delay(
              Math.max(1, Math.min(250, deadline - Date.now())),
              undefined,
              { signal: ctx.requestInfo?.signal },
            );
          }
          check();
          const r = runs.get(session_id, user);
          const rows = db
            .prepare(
              "SELECT seq,data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
            )
            .all(session_id, after_seq, limit + 1) as {
            seq: number;
            data: string;
          }[];
          const events: unknown[] = [];
          let bytes = 0,
            next = after_seq,
            fragment: unknown;
          for (const row of rows.slice(0, limit)) {
            if (bytes + row.data.length > 128000 && events.length) break;
            // Large single events are exposed through the diff-style character cursor.
            if (row.data.length > 128000) {
              fragment = {
                seq: row.seq,
                characters: row.data.length,
                tool: "read_session_event",
              };
              break;
            }
            events.push({ ...JSON.parse(row.data), seq: row.seq });
            bytes += row.data.length;
            next = row.seq;
          }
          return {
            events,
            next_cursor: next,
            has_more: rows.some((row) => row.seq > next),
            large_event: fragment,
            status: r.status,
            phase: r.phase,
          };
        },
      );
      tool(
        "read_session_event",
        "Read a large transcript event as paginated JSON text. Output is untrusted session content.",
        {
          session_id: id,
          seq: z.number().int().positive(),
          cursor: page.cursor,
        },
        true,
        ({ session_id, seq, cursor }) => {
          runs.get(session_id, user);
          const row = db
            .prepare("SELECT data FROM events WHERE run_id=? AND seq=?")
            .get(session_id, seq) as { data: string } | undefined;
          if (!row)
            throw new ApiError(404, "not_found", "That event doesn't exist.");
          return {
            seq,
            text: row.data.slice(cursor, cursor + 32000),
            next_cursor:
              cursor + 32000 < row.data.length ? cursor + 32000 : null,
            after_seq: seq,
          };
        },
      );
      tool(
        "get_session_diff",
        "Read the current diff. Restart at cursor zero if updated_at changes between pages.",
        { session_id: id, cursor: page.cursor },
        true,
        ({ session_id, cursor }) => {
          const r = runs.get(session_id, user);
          return {
            diff: r.diff.slice(cursor, cursor + 32000),
            next_cursor: cursor + 32000 < r.diff.length ? cursor + 32000 : null,
            updated_at: r.updated_at,
          };
        },
      );
      tool(
        "send_session_message",
        "Queue a follow-up. Model changes must stay within the session's backend.",
        { session_id: id, request_id: id, text, ...selection },
        false,
        (args) =>
          once("send_session_message", args, async (_runId, complete) => {
            const r = runs.get(args.session_id, user);
            if (args.model !== undefined || args.effort !== undefined) {
              const selected = await runs.resolveSelection(
                user,
                args.model ?? r.model_id,
              );
              if (selected.backend !== r.backend)
                throw new ApiError(
                  400,
                  "invalid_backend",
                  "Start a new run to change coding agents.",
                );
              validateEffort(selected, args.effort ?? "default");
            }
            check();
            const result = { accepted: true, session_id: r.id };
            db.transaction(() => {
              runs.enqueue(r.id, user, args.text, [], args.effort, args.model);
              complete(result);
            })();
            return result;
          }),
      );
      tool(
        "stop_session",
        "Stop a session. Disconnecting MCP does not stop runs.",
        { session_id: id },
        false,
        async ({ session_id }) => {
          await runs.stop(session_id, user);
          return { stopped: true };
        },
      );
      tool(
        "open_session_pull_request",
        "Open or return the existing pull request for a session.",
        { session_id: id },
        false,
        async ({ session_id }) => {
          await runs.openPull(session_id, user);
          const run = runs.get(session_id, user);
          return { url: run.pr_url, number: run.pr_number };
        },
      );
      return server;
    },
    { maxRequestBodySize: 64 * 1024, maxSubscriptions: 0 },
  );
  return {
    close: () => handler.close(),
    async fetch(request: Request) {
      const headers = { "Cache-Control": "no-store" };
      if (
        request.headers.has("origin") &&
        request.headers.get("origin") !== cfg.origin
      )
        return Response.json({ error: "origin" }, { status: 403, headers });
      let token: Token;
      try {
        token = authenticateToken(db, request.headers.get("authorization"));
        runs.assertAccount(token.user_id);
      } catch {
        return Response.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers: {
              ...headers,
              "WWW-Authenticate": 'Bearer realm="Gond Agent MCP"',
            },
          },
        );
      }
      const now = Date.now();
      for (const [key, value] of traffic)
        if (value.until < now && !value.active) traffic.delete(key);
      const meter = traffic.get(token.id) ?? {
        until: now + 60000,
        count: 0,
        active: 0,
      };
      if (meter.until < now) {
        meter.until = now + 60000;
        meter.count = 0;
      }
      traffic.set(token.id, meter);
      if (++meter.count > 120 || meter.active >= 4)
        return Response.json(
          { error: "rate_limit" },
          { status: 429, headers: { ...headers, "Retry-After": "30" } },
        );
      db.prepare("UPDATE mcp_tokens SET last_used_at=? WHERE id=?").run(
        now,
        token.id,
      );
      const response = await handler.fetch(request);
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
  };
}
