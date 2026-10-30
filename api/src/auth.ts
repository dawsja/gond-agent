import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { getMigrations } from "better-auth/db/migration";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Config } from "./config";
import { getSetting, setSetting, type Store } from "./db";

export interface OIDC {
  enabled: boolean;
  name: string;
  issuer: string;
  clientId: string;
  secret: string;
}
export function seal(secret: string, value: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      iv,
    );
  return Buffer.concat([
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function unseal(secret: string, value: string): string {
  const b = Buffer.from(value, "base64"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      b.subarray(0, 12),
    );
  decipher.setAuthTag(b.subarray(-16));
  return Buffer.concat([
    decipher.update(b.subarray(12, -16)),
    decipher.final(),
  ]).toString();
}
export async function createAuthentication(db: Store, cfg: Config) {
  const build = () => {
    const oidc = getSetting<OIDC>(db, "oidc");
    return betterAuth({
      appName: "Gond Agent",
      baseURL: cfg.origin,
      basePath: "/api/auth",
      secret: cfg.secret,
      database: db,
      trustedOrigins: [cfg.origin],
      emailAndPassword: {
        enabled: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
      },
      session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
      account: { accountLinking: { enabled: false } },
      rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
      advanced: {
        ipAddress: { ipAddressHeaders: ["x-gond-agent-client-ip"] },
        useSecureCookies: cfg.origin.startsWith("https://"),
      },
      databaseHooks: {
        user: {
          create: {
            before: async () => {
              // Closed instance by default. The first account is bootstrapped on a private bind address.
              const n = (
                db.prepare('SELECT count(*) AS n FROM "user"').get() as {
                  n: number;
                }
              ).n;
              if (n && !cfg.signup) return false;
            },
            after: async (user) => {
              db.transaction(() => {
                if (!db.prepare("SELECT 1 FROM administrators LIMIT 1").get())
                  db.prepare(
                    "INSERT INTO administrators(user_id) VALUES(?)",
                  ).run(user.id);
                db.prepare(
                  "INSERT OR IGNORE INTO profiles(user_id) VALUES(?)",
                ).run(user.id);
              })();
            },
          },
        },
      },
      plugins: [
        genericOAuth({
          config: oidc?.enabled
            ? [
                {
                  providerId: "oidc",
                  clientId: oidc.clientId,
                  clientSecret: unseal(cfg.secret, oidc.secret),
                  discoveryUrl:
                    oidc.issuer.replace(/\/$/, "") +
                    "/.well-known/openid-configuration",
                  scopes: ["openid", "profile", "email"],
                  pkce: true,
                  requireIdTokenVerification: true,
                },
              ]
            : [],
        }),
      ],
    });
  };
  let auth = build();
  await (await getMigrations(auth.options)).runMigrations();
  return {
    get current() {
      return auth;
    },
    providers() {
      const o = getSetting<OIDC>(db, "oidc");
      return o?.enabled ? [{ id: "oidc", name: o.name }] : [];
    },
    oidc() {
      const o = getSetting<OIDC>(db, "oidc");
      return o
        ? { ...o, secret: undefined, hasSecret: !!o.secret }
        : {
            enabled: false,
            name: "Single sign-on",
            issuer: "",
            clientId: "",
            hasSecret: false,
          };
    },
    saveOIDC(input: Omit<OIDC, "secret"> & { clientSecret?: string }) {
      const old = getSetting<OIDC>(db, "oidc");
      const issuer = input.issuer ? new URL(input.issuer) : null;
      if (
        issuer &&
        (issuer.protocol !== "https:" ||
          issuer.username ||
          issuer.password ||
          issuer.search ||
          issuer.hash)
      )
        throw new Error(
          "Use an HTTPS issuer URL without credentials or query parameters.",
        );
      const secret = input.clientSecret
        ? seal(cfg.secret, input.clientSecret)
        : (old?.secret ?? "");
      if (input.enabled && (!issuer || !input.clientId.trim() || !secret))
        throw new Error("Enter an issuer, client ID and client secret.");
      setSetting(db, "oidc", {
        enabled: !!input.enabled,
        name: input.name.trim().slice(0, 80) || "Single sign-on",
        issuer: issuer?.toString().replace(/\/$/, "") ?? "",
        clientId: input.clientId.trim(),
        secret,
      });
      auth = build();
    },
  };
}
export type Authentication = Awaited<ReturnType<typeof createAuthentication>>;
