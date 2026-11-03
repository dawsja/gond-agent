export function isLocalProfilePhoto(value: unknown): value is string {
  return typeof value === "string" && /^\/api\/v1\/users\/[a-zA-Z0-9_-]+\/photo(?:\?v=[a-zA-Z0-9_-]+)?$/.test(value);
}
