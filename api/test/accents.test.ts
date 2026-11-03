import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCENTS, DEFAULT_ACCENT } from "../../shared/accents";

const sourceDir = fileURLToPath(new URL("../../web/src/", import.meta.url));
const cssPath = join(sourceDir, "index.css");
const css = readFileSync(cssPath, "utf8");
const accentBlock = /\[data-accent\s*=\s*["']([^"']+)["']\]\s*\{([^{}]*)\}/g;
const blocks = [...css.matchAll(accentBlock)];
const tokens = ["--tint", "--tint-solid", "--tint-wash", "--tint-edge", "--tint-ink"];
const declarations = (body: string) => [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
  .map(([, name, value]) => [name, value.trim()] as const);
const palettes = blocks.map(([, name, body]) => ({ name, entries: declarations(body) }));
const colors = new Set(palettes.flatMap(({ entries }) => entries.map(([, value]) => value.toLowerCase())));

function luminance(hex: string) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
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
  it("defines exactly the shared accent choices, once each, with only five hex tokens", () => {
    const selectors = [...css.matchAll(/\[data-accent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*\]/gi)];
    expect(selectors.map(([, double, single, bare]) => double ?? single ?? bare).sort()).toEqual([...ACCENTS].sort());
    expect(blocks.map(([, name]) => name).sort()).toEqual([...ACCENTS].sort());
    for (const { name, entries } of palettes) {
      expect(entries.map(([token]) => token).sort(), name).toEqual([...tokens].sort());
      for (const [token, value] of entries) expect(value, `${name} ${token}`).toMatch(/^#[\da-f]{6}$/i);
    }
    const root = /:root\s*\{([^{}]*)\}/.exec(css)?.[1] ?? "";
    expect(root).toMatch(/color-scheme:\s*dark\s*;/);
    expect(declarations(root).filter(([token]) => tokens.includes(token)))
      .toEqual(palettes.find(({ name }) => name === DEFAULT_ACCENT)?.entries);
  });

  it("keeps white text at WCAG AA contrast on every solid accent", () => {
    for (const { name, entries } of palettes) {
      const solid = entries.find(([token]) => token === "--tint-solid")?.[1];
      expect(solid, name).toMatch(/^#[\da-f]{6}$/i);
      const contrast = (luminance("#ffffff") + 0.05) / (luminance(solid!) + 0.05);
      expect(contrast, `${name} solid against white`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps palette literals in CSS definitions, not components or other CSS rules", () => {
    for (const path of files(sourceDir)) {
      if (path === cssPath) continue;
      expect(paletteLiterals(readFileSync(path, "utf8")), path).toEqual([]);
    }
    const otherRules = css.replace(/:root\s*\{[^{}]*\}/g, "").replace(accentBlock, "");
    expect(paletteLiterals(otherRules), "CSS outside root and accent blocks").toEqual([]);
  });
});
