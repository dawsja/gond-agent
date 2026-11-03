import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

export interface IdTokenClaims { iss: string; sub: string; aud: string | string[]; exp: number; nonce?: string; email?: string; [key: string]: unknown }

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

/** Verifies an OIDC ID token signature against a JWKS, then its issuer, audience, expiry and nonce. */
export async function verifyIdToken(token: string, options: {
  keys: (refresh: boolean) => Promise<JsonWebKey[]>;
  issuer: string; audience: string; nonce: string; now?: number;
}): Promise<IdTokenClaims> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || token.length > 16384) throw new Error("Malformed ID token");
  const header = decode(parts[0]!), claims = decode(parts[1]!) as unknown as IdTokenClaims;
  const alg = header.alg;
  if (alg !== "RS256" && alg !== "ES256") throw new Error("Unsupported ID token algorithm");
  const pick = (keys: JsonWebKey[]) => keys.find(k => (header.kid === undefined || (k as { kid?: unknown }).kid === header.kid) && k.kty === (alg === "RS256" ? "RSA" : "EC"));
  const key = pick(await options.keys(false)) ?? pick(await options.keys(true));
  if (!key) throw new Error("Unknown ID token signing key");
  const publicKey = createPublicKey({ key, format: "jwk" });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), signature = Buffer.from(parts[2]!, "base64url");
  const valid = alg === "RS256"
    ? verify("sha256", data, publicKey, signature)
    : verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  if (!valid) throw new Error("Invalid ID token signature");
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== options.issuer) throw new Error("Unexpected ID token issuer");
  if (!audiences.includes(options.audience)) throw new Error("Unexpected ID token audience");
  if (typeof claims.exp !== "number" || claims.exp + 60 < now) throw new Error("Expired ID token");
  if (claims.nonce !== options.nonce) throw new Error("Unexpected ID token nonce");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new Error("Missing ID token subject");
  return claims;
}
