import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, clearExternalProfileImages } from "../src/db";
import { createAuthentication, oidcProfileToUser } from "../src/auth";
import { photoFor, savePhoto } from "../src/profile-photo";
import { isLocalProfilePhoto } from "../../shared/profile-photo";
import sharp from "sharp";

let dir: string, db: ReturnType<typeof openStore>, auth: Awaited<ReturnType<typeof createAuthentication>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gond-photo-policy-"));
  db = openStore(dir);
  auth = await createAuthentication(db, { data: dir, origin: "http://localhost:8787", secret: "fixture-photo-policy-secret-at-least-32-characters", signup: true, port: 8787, dockerBin: "docker", workerImage: "unused", maxRuns: 2, runCPUs: 1, runMemoryMB: 2048 });
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

it("strips provider pictures and protects all user creation and update paths", async () => {
  const profile = { name: "OIDC User", email: "oidc@example.test", picture: "https://www.gravatar.com/avatar/x", image: "https://www.gravatar.com/avatar/x" };
  expect(oidcProfileToUser(profile)).toEqual({ name: profile.name, email: profile.email, image: undefined });
  const { internalAdapter } = await auth.current.$context;
  const user = await internalAdapter.createUser({ ...profile, emailVerified: true }, { method: "oauth", oauth: { providerId: "oidc", profile: {} } });
  const image = () => db.prepare('SELECT image FROM "user" WHERE id=?').get(user.id);
  expect(image()).toEqual({ image: null });
  for (const value of [profile.image, "//external.test/photo", "data:image/png;base64,eA==", "/api/v1/users/../external/photo"]) {
    await internalAdapter.updateUser(user.id, { image: value });
    expect(image()).toEqual({ image: null });
  }
  const local = `/api/v1/users/${user.id}/photo?v=revision`;
  await internalAdapter.updateUser(user.id, { image: local });
  await internalAdapter.updateUser(user.id, { name: "Updated name" });
  expect(image()).toEqual({ image: local });
  await internalAdapter.updateUser(user.id, { image: profile.image });
  expect(image()).toEqual({ image: null });
});

it("only exposes stored uploaded photos, regardless of the account image", async () => {
  const { internalAdapter } = await auth.current.$context;
  const user = await internalAdapter.createUser({ name: "Photo", email: "photo@example.test", emailVerified: true }, { method: "oauth", oauth: { providerId: "oidc", profile: {} } });
  const legacy = { ...user, image: "https://www.gravatar.com/avatar/x" };
  expect(photoFor(db, legacy)).toEqual({ image: null, has_photo: false });
  const input = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#999999" } }).png().toBuffer();
  await savePhoto(db, user.id, input);
  expect(photoFor(db, legacy)).toEqual({ image: expect.stringMatching(/^\/api\/v1\/users\/[^/]+\/photo\?v=[a-f0-9]{24}$/), has_photo: true });
  db.prepare("DELETE FROM profile_photos WHERE user_id=?").run(user.id);
  expect(photoFor(db, legacy)).toEqual({ image: null, has_photo: false });
});

it("clears only non-local account images at startup, keeps uploaded photos and is idempotent", async () => {
  const { internalAdapter } = await auth.current.$context;
  const values = [null, "/api/v1/users/local/photo?v=revision", "https://www.gravatar.com/avatar/x", "//external.test/x", "data:image/png;base64,eA==", "/other/path"];
  for (const [n, image] of values.entries()) {
    const user = await internalAdapter.createUser({ name: "Migration", email: `migration${n}@example.test`, emailVerified: true }, { method: "oauth", oauth: { providerId: "oidc", profile: {} } });
    db.prepare('UPDATE "user" SET image=? WHERE id=?').run(image, user.id);
    db.prepare("INSERT INTO profile_photos(user_id,revision,bytes) VALUES(?,?,?)").run(user.id, "kept", Buffer.from("kept"));
  }
  db.close(); db = openStore(dir);
  expect(db.prepare('SELECT image FROM "user" ORDER BY email').all()).toEqual(values.map(image => ({ image: isLocalProfilePhoto(image) ? image : null })));
  expect(db.prepare("SELECT count(*) AS n FROM profile_photos WHERE revision='kept' AND bytes=?").get(Buffer.from("kept"))).toEqual({ n: values.length });
  expect(clearExternalProfileImages(db)).toBe(0);
});

it("rejects URL parser tricks rather than treating arbitrary same-origin URLs as photos", () => {
  for (const value of ["https://app.test/api/v1/users/a/photo", "//app.test/api/v1/users/a/photo", "/api/v1/users/../photo", "/api/v1/users/a/../../photo", "/api/v1/users/a/photo?redirect=https://external.test", "/api/v1/users/a\\photo", "data:image/png;base64,eA=="]) expect(isLocalProfilePhoto(value)).toBe(false);
  expect(isLocalProfilePhoto("/api/v1/users/user-1/photo?v=abc123")).toBe(true);
});
