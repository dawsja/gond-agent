import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");
const value = (name: string): string => {
  const raw = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
  if (!raw) throw new Error(`Missing theme token ${name}`);
  return raw.startsWith("var(") ? value(raw.slice(6, -1)) : raw;
};
const light = (hex: string) => {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
const contrast = (a: string, b: string) => (Math.max(light(a), light(b)) + .05) / (Math.min(light(a), light(b)) + .05);
describe("Gond Code default blue palette", () => {
  it("matches the reference colors without changing fonts or layout", () => {
    expect([value("background"), value("sidebar"), value("card"), value("raised"), value("border"), value("primary"), value("link"), value("ring")])
      .toEqual(["#000000", "#030303", "#0e0e0e", "#141414", "#1c1c1c", "#2b61b9", "#8db0e8", "#5c5c5c"]);
  });
  it("keeps text and primary actions readable", () => {
    for (const surface of ["background", "card", "raised", "secondary", "accent"]) for (const text of ["foreground", "muted-foreground", "link", "good", "warning", "bad", "info"])
      expect(contrast(value(text), value(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(value("primary-foreground"), value("primary"))).toBeGreaterThanOrEqual(4.5);
  });
});
