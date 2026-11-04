import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCENTS, DEFAULT_ACCENT } from "../../shared/accents";

const sourceDir = fileURLToPath(new URL("../../web/src/", import.meta.url));
const cssPath = join(sourceDir, "index.css");
const css = readFileSync(cssPath, "utf8");
// The original generic selectors supply dark values; the more specific light
// root selectors override them without changing those established palettes.
const accentBlock = /(?:^|\n)(:root:not\(\.dark\))?\[data-accent\s*=\s*["']([^"']+)["']\]\s*\{([^{}]*)\}/g;
const baseBlock = /(?:^|\n)(:root|\.dark)\s*\{([^{}]*)\}/g;
const blocks = [...css.matchAll(accentBlock)];
const tokens = ["--tint", "--tint-solid", "--tint-wash", "--tint-edge", "--tint-ink"];
const declarations = (body: string) => [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
  .map(([, name, value]) => [name, value.trim()] as const);
const palettes = blocks.map(([, light, name, body]) => ({
  scheme: light ? "light" : "dark", name, entries: declarations(body),
}));
const roots = [...css.matchAll(baseBlock)].map(([, selector, body]) => ({
  scheme: selector === ":root" ? "light" : "dark", body, entries: declarations(body),
}));
const colors = new Set(palettes.flatMap(({ entries }) => entries.map(([, value]) => value.toLowerCase())));

// Snapshot from origin/main 8a1fab4:web/src/index.css, in the token order above.
// Adding light mode must not retune any of the seven existing dark choices.
const originalDark: Record<typeof ACCENTS[number], string[]> = {
  blue: ["#2f6fd6", "#2b61b9", "#252f40", "#3d5780", "#8db0e8"],
  purple: ["#7650d8", "#6747ba", "#302a40", "#5a4b81", "#b49fea"],
  pink: ["#cf3d85", "#b33774", "#3f2733", "#7d4360", "#e594bc"],
  red: ["#d03a3a", "#b33434", "#3f2727", "#7e4242", "#e59393"],
  orange: ["#e04e0a", "#c1450b", "#412a1f", "#844a2f", "#ee9e78"],
  amber: ["#d98a08", "#9f670b", "#40331f", "#81622e", "#eabf77"],
  green: ["#189c47", "#17853e", "#213629", "#346947", "#80c99a"],
};

function luminance(hex: string) {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected a six-digit CSS color, got ${hex}`);
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function contrast(a: string, b: string) {
  return (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

function paletteLiterals(source: string) {
  return [...source.matchAll(/#[\da-f]{6}\b/gi)].map(match => match[0].toLowerCase())
    .filter(hex => colors.has(hex));
}

describe("account accent palettes", () => {
  it("defines every shared accent exactly once per scheme, with only five hex tokens", () => {
    const selectors = [...css.matchAll(/\[data-accent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*\]/gi)];
    expect(selectors.map(([, double, single, bare]) => double ?? single ?? bare).sort())
      .toEqual([...ACCENTS, ...ACCENTS].sort());
    for (const scheme of ["light", "dark"]) {
      expect(palettes.filter(palette => palette.scheme === scheme).map(({ name }) => name).sort(), scheme)
        .toEqual([...ACCENTS].sort());
      const schemeRoots = roots.filter(root => root.scheme === scheme);
      expect(schemeRoots, `${scheme} base palette`).toHaveLength(1);
      const root = schemeRoots[0];
      expect(root.body).toMatch(new RegExp(`color-scheme:\\s*${scheme}\\s*;`));
      expect(Object.fromEntries(root.entries.filter(([token]) => tokens.includes(token))), `${scheme} default`)
        .toEqual(Object.fromEntries(palettes.find(palette => palette.scheme === scheme && palette.name === DEFAULT_ACCENT)!.entries));
    }
    for (const { scheme, name, entries } of palettes) {
      expect(entries.map(([token]) => token).sort(), `${scheme} ${name}`).toEqual([...tokens].sort());
      for (const [token, value] of entries) expect(value, `${scheme} ${name} ${token}`).toMatch(/^#[\da-f]{6}$/i);
    }
  });

  it("preserves the exact original dark accent values", () => {
    for (const name of ACCENTS) {
      const entries = Object.fromEntries(palettes.find(palette => palette.scheme === "dark" && palette.name === name)!.entries);
      expect(tokens.map(token => entries[token]), name).toEqual(originalDark[name]);
    }
  });

  it("keeps white on solid and accent ink on page and wash at WCAG AA contrast in both schemes", () => {
    for (const { scheme, name, entries } of palettes) {
      const palette = Object.fromEntries(entries);
      const root = Object.fromEntries(roots.find(root => root.scheme === scheme)!.entries);
      expect(contrast("#ffffff", palette["--tint-solid"]), `${scheme} ${name} solid against white`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["--tint-ink"], root["--background"]), `${scheme} ${name} ink on page`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["--tint-ink"], palette["--tint-wash"]), `${scheme} ${name} ink on wash`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps palette literals in CSS definitions, not components or other CSS rules", () => {
    for (const path of files(sourceDir)) {
      if (path === cssPath) continue;
      expect(paletteLiterals(readFileSync(path, "utf8")), path).toEqual([]);
    }
    const otherRules = css.replace(baseBlock, "").replace(accentBlock, "");
    expect(paletteLiterals(otherRules), "CSS outside base theme and accent blocks").toEqual([]);
  });
});
