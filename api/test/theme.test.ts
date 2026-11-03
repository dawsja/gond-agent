import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, isTheme, THEMES, themeInitScript } from "../../shared/theme-preference";

const css = readFileSync(new URL("../../web/src/index.css", import.meta.url), "utf8");
const tokens = (block: string) => Object.fromEntries(
  [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, raw]) => [name, raw.trim()]),
);
const palette = (selector: string) => {
  const block = css.match(new RegExp(`(?:^|\\n)${selector} \\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing palette ${selector}`);
  return { block, tokens: tokens(block) };
};
const palettes = { light: palette(":root"), dark: palette("\\.dark") };
type Scheme = keyof typeof palettes;
const value = (scheme: Scheme, name: string, seen: string[] = []): string => {
  if (seen.includes(name)) throw new Error(`Circular theme token ${name}`);
  const raw = palettes[scheme].tokens[name];
  if (!raw) throw new Error(`Missing ${scheme} theme token ${name}`);
  const alias = /^var\(--([\w-]+)\)$/.exec(raw);
  return alias ? value(scheme, alias[1], [...seen, name]) : raw;
};
const rgb = (hex: string) => {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected a six-digit CSS color, got ${hex}`);
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
};
const luminance = (channels: number[]) => {
  const rgb = channels.map(c => c / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
const contrastRGB = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const contrast = (a: string, b: string) => contrastRGB(rgb(a), rgb(b));
const ratio = (scheme: Scheme, text: string, surface: string) => contrast(value(scheme, text), value(scheme, surface));

// Raw values (including aliases) from the original dark-only palette. New light-mode
// tokens must not quietly retune the established dark appearance.
const originalDark = tokens(`
  --background: #000000; --inset: #030303; --surface: #0e0e0e;
  --card: #0e0e0e; --popover: #0e0e0e; --raised: #141414;
  --foreground: #ededed; --card-foreground: #ededed; --popover-foreground: #ededed;
  --tint: #2f6fd6; --tint-solid: #2b61b9; --tint-wash: #252f40;
  --tint-edge: #3d5780; --tint-ink: #8db0e8;
  --primary: var(--tint-solid); --primary-foreground: #ffffff; --amber: #fdd663;
  --secondary: #1a1a1a; --secondary-foreground: #ededed;
  --muted: #1a1a1a; --muted-foreground: #8a8a8a; --subtle: #8a8a8a;
  --accent: #1e1e1e; --accent-foreground: #ededed;
  --accent-soft: var(--tint-wash); --link: var(--tint-ink); --destructive: #e5484d;
  --border: #1c1c1c; --border-strong: #262626; --input: #262626;
  --ring: #5c5c5c; --radius: 0.375rem;
  --good: #a5d6a7; --warning: #ffe082; --bad: #ef9a9a; --info: #90caf9;
  --status-working: var(--warning); --status-ready: var(--good); --status-merged: #bc8cff;
  --status-failed: var(--bad); --status-stopped: var(--muted-foreground);
  --diff-add: var(--good); --diff-del: var(--bad);
  --syn-keyword: #c58af9; --syn-string: #81c995; --syn-number: var(--amber);
  --syn-type: #8ab4f8; --syn-fn: #8ab4f8;
  --diff-add-line: color-mix(in srgb, var(--good) 16%, var(--background));
  --diff-add-gutter: color-mix(in srgb, var(--good) 22%, var(--background));
  --diff-del-line: color-mix(in srgb, var(--bad) 16%, var(--background));
  --diff-del-gutter: color-mix(in srgb, var(--bad) 22%, var(--background));
  --chart-1: var(--primary); --chart-2: var(--amber); --chart-3: var(--good);
  --chart-4: var(--info); --chart-5: var(--muted-foreground);
  --sidebar: #030303; --sidebar-foreground: #ededed;
  --sidebar-primary: var(--tint-solid); --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #1a1a1a; --sidebar-accent-foreground: #ededed;
  --sidebar-border: #1c1c1c; --sidebar-ring: var(--ring);
`);

describe("Gond Code default blue palette", () => {
  it("preserves every existing dark token, fonts and radii", () => {
    expect(palettes.dark.tokens).toMatchObject(originalDark);
    expect([value("dark", "background"), value("dark", "sidebar"), value("dark", "card"), value("dark", "raised"), value("dark", "border"), value("dark", "primary"), value("dark", "link"), value("dark", "ring")])
      .toEqual(["#000000", "#030303", "#0e0e0e", "#141414", "#1c1c1c", "#2b61b9", "#8db0e8", "#5c5c5c"]);
    expect(css).toContain("--font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;");
    expect(css).toContain("--font-mono: 'JetBrains Mono Variable', ui-monospace, monospace;");
  });

  it("uses Gond's linen, paper, mist, carbon and light blue shades", () => {
    expect(["background", "card", "secondary", "foreground", "tint", "tint-solid", "tint-wash", "tint-edge", "tint-ink"].map(name => value("light", name)))
      .toEqual(["#f5f3ee", "#ffffff", "#ebe8e1", "#1b1a18", "#2f6fd6", "#2c62ba", "#d6dbe0", "#a9b8cd", "#29559d"]);
  });

  it("provides identical, self-contained semantic token sets in both schemes", () => {
    expect(Object.keys(palettes.light.tokens).sort()).toEqual(Object.keys(palettes.dark.tokens).sort());
    for (const scheme of ["light", "dark"] as const) {
      expect(palettes[scheme].block).toContain(`color-scheme: ${scheme};`);
      expect(value(scheme, "radius")).toBe("0.375rem");
      for (const [name, raw] of Object.entries(palettes[scheme].tokens)) {
        value(scheme, name); // Detect missing and circular aliases, not just matching keys.
        for (const [, reference] of raw.matchAll(/var\(--([\w-]+)\)/g))
          expect(palettes[scheme].tokens, `${scheme}: ${name} references ${reference}`).toHaveProperty(reference);
      }
    }
  });

  it("keeps the gray avatar and flat dark elevation, with neutral light equivalents", () => {
    expect([value("dark", "avatar-background"), value("dark", "avatar-foreground")]).toEqual(["#1a1a1a", "#8a8a8a"]);
    expect([value("light", "avatar-background"), value("light", "avatar-foreground")]).toEqual(["#ebe8e1", "#524f4a"]);
    for (const name of ["elevation-subtle", "elevation-subtle-2", "elevation-subtle-3"]) {
      expect(value("dark", name)).toBe("none");
      expect(value("light", name)).toContain("rgba(20, 16, 8,");
    }
  });

  for (const scheme of ["light", "dark"] as const) {
    it(`keeps ${scheme} text, links and status ink at WCAG AA on workspace surfaces`, () => {
      // Preserve the original 4.5:1 checks, and extend them to the rail, inset,
      // surface, popovers, subtle text, merged state and code syntax colors.
      for (const surface of ["background", "card", "raised", "secondary", "accent", "inset", "surface", "popover", "sidebar", "muted", "sidebar-accent"])
        for (const text of ["foreground", "muted-foreground", "subtle", "link", "good", "warning", "bad", "info", "amber", "status-working", "status-ready", "status-merged", "status-failed", "status-stopped", "diff-add", "diff-del", "syn-keyword", "syn-string", "syn-number", "syn-type", "syn-fn"])
          expect(ratio(scheme, text, surface), `${scheme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`keeps ${scheme} paired surfaces and white primary actions readable`, () => {
      for (const surface of ["card", "popover", "secondary", "accent", "sidebar", "sidebar-accent", "primary", "sidebar-primary"])
        expect(ratio(scheme, `${surface}-foreground`, surface), `${scheme}: ${surface} foreground`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(scheme, "primary-foreground", "tint-solid")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(scheme, "link", "accent-soft")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(scheme, "avatar-foreground", "avatar-background")).toBeGreaterThanOrEqual(4.5);
      if (scheme === "light") for (const hover of ["primary-hover", "destructive-hover"])
        expect(ratio(scheme, "primary-foreground", hover), `white on light ${hover}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("does not regress inherited dark destructive and focus contrast floors", () => {
    // These are existing exceptions, NOT claims of AA conformance: red on the
    // brightest dark hover is 4.26:1 and the solid focus ring is 2.49:1.
    expect(ratio("dark", "destructive", "accent")).toBeGreaterThanOrEqual(4.25);
    expect(ratio("dark", "ring", "accent")).toBeGreaterThanOrEqual(2.49);
    // Keep the old translucent Tailwind hover treatment in dark; light must use
    // solid deeper ink, because fading a blue/red button toward paper loses AA.
    expect(value("dark", "primary-hover")).toBe("color-mix(in oklab, var(--primary) 85%, transparent)");
    expect(value("dark", "destructive-hover")).toBe("color-mix(in oklab, var(--destructive) 85%, transparent)");
    for (const surface of ["background", "card", "surface", "popover", "sidebar", "raised", "secondary", "accent"]) {
      expect(ratio("light", "destructive", surface)).toBeGreaterThanOrEqual(4.5);
      expect(ratio("light", "ring", surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps light syntax, diff markers and line numbers readable on the actual diff washes", () => {
    for (const surface of ["diff-add-line", "diff-add-gutter", "diff-del-line", "diff-del-gutter"]) {
      const mix = /^color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--([\w-]+)\)\)$/.exec(value("light", surface));
      if (!mix) throw new Error(`Unsupported diff wash ${surface}`);
      const amount = Number(mix[2]) / 100;
      const base = rgb(value("light", mix[3]));
      const background = rgb(value("light", mix[1])).map((c, index) => c * amount + base[index] * (1 - amount));
      for (const text of ["foreground", "muted-foreground", "subtle", "diff-add", "diff-del", "syn-keyword", "syn-string", "syn-number", "syn-type", "syn-fn"])
        expect(contrastRGB(rgb(value("light", text)), background), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps hardcoded hex colors out of workspace components", () => {
    const root = new URL("../../web/src/", import.meta.url);
    const violations: string[] = [];
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) continue;
      const path = `${entry.parentPath}/${entry.name}`;
      const relative = path.slice(root.pathname.length).replace(/^\/+/, "");
      if (["index.css", "lib/theme.ts"].includes(relative)) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        if (/#[\da-f]{3,8}\b/i.test(line)) violations.push(`${relative}:${index + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });
});

describe("theme preference contract", () => {
  it("accepts exactly System, Light and Dark, defaulting to System", () => {
    expect(THEMES).toEqual(["system", "light", "dark"]);
    expect(DEFAULT_THEME).toBe("system");
    for (const theme of THEMES) expect(isTheme(theme)).toBe(true);
    for (const invalid of [undefined, null, "", "auto", "Dark", "gond", 0, {}, ["light"]]) expect(isTheme(invalid)).toBe(false);
  });
});

// The theme module has no React dependencies; stub only its browser boundary.
// Keep unrelated root classes to catch wholesale className replacement.
describe("browser theme application", () => {
  afterEach(() => vi.unstubAllGlobals());

  const browser = (dark: boolean) => {
    const classes = new Set(["workspace", "dark"]);
    const root = {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
      },
      style: { colorScheme: "dark" },
      dataset: {} as Record<string, string>,
    };
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
    const matchMedia = vi.fn(() => ({ matches: dark }));
    const meta = { setAttribute: vi.fn() };
    vi.stubGlobal("document", { documentElement: root, querySelectorAll: () => [meta] });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => root.style.colorScheme === "dark" ? value("dark", "background") : value("light", "background") }));
    vi.stubGlobal("window", { matchMedia, localStorage });
    vi.stubGlobal("matchMedia", matchMedia);
    vi.stubGlobal("localStorage", localStorage);
    return { root, classes, matchMedia, meta, storage };
  };

  it("resolves explicit choices independently of the OS, and System in both directions", async () => {
    const stub = browser(true);
    const { DARK_QUERY, resolveTheme } = await import("../../web/src/lib/theme");
    expect(DARK_QUERY).toBe("(prefers-color-scheme: dark)");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");
    expect(stub.matchMedia).toHaveBeenCalledWith(DARK_QUERY);
    stub.matchMedia.mockReturnValue({ matches: false });
    expect(resolveTheme("system")).toBe("light");
  });

  it("applies resolved scheme and native color-scheme without dropping unrelated classes", async () => {
    const { root, classes, meta } = browser(true);
    const { applyTheme } = await import("../../web/src/lib/theme");
    applyTheme("light", "system");
    expect(classes.has("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.theme).toBe("system");
    expect(meta.setAttribute).toHaveBeenLastCalledWith("content", value("light", "background"));
    expect(classes.has("workspace")).toBe(true);
    applyTheme("dark", "dark");
    expect(classes.has("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(meta.setAttribute).toHaveBeenLastCalledWith("content", value("dark", "background"));
    expect(classes.has("workspace")).toBe(true);
  });

  it("bootstraps cached themes before modules and tolerates unavailable or invalid storage", () => {
    const script = themeInitScript({ light: value("light", "background"), dark: value("dark", "background") });
    for (const deviceDark of [true, false]) for (const stored of [...THEMES, "invalid", null, "throws"]) {
      const { root, classes, meta } = browser(deviceDark);
      const preference = isTheme(stored) ? stored : "system";
      const dark = preference === "dark" || (preference === "system" && deviceDark);
      runInNewContext(script, {
        document, matchMedia: () => ({ matches: deviceDark }),
        localStorage: { getItem: () => { if (stored === "throws") throw new Error("Storage disabled"); return stored; } },
      });
      expect(classes.has("dark")).toBe(dark);
      expect(root.dataset.theme).toBe(preference);
      expect(root.style.colorScheme).toBe(dark ? "dark" : "light");
      expect(meta.setAttribute).toHaveBeenLastCalledWith("content", value(dark ? "dark" : "light", "background"));
    }
  });

  it("follows device changes only in System and cleans up its listener", async () => {
    const { root, classes, matchMedia } = browser(false);
    let change: () => void = () => {};
    const media = { matches: false, addEventListener: vi.fn((_event, listener) => { change = listener; }), removeEventListener: vi.fn() };
    matchMedia.mockReturnValue(media);
    const { followSystemTheme, setTheme, readStoredTheme } = await import("../../web/src/lib/theme");
    expect(readStoredTheme()).toBe("system");
    setTheme("system");
    const dispose = followSystemTheme();
    media.matches = true; change();
    expect(classes.has("dark")).toBe(true);
    expect(root.dataset.theme).toBe("system");
    setTheme("light"); change();
    expect(classes.has("dark")).toBe(false);
    expect(readStoredTheme()).toBe("light");
    dispose();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", change);
  });
});
