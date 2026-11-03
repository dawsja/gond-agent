import { ACCENTS, DEFAULT_ACCENT } from "./accents";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "system";
export const THEME_STORAGE_KEY = "gond-agent-theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && THEMES.some(theme => theme === value);
}

/** Synchronous head bootstrap; Vite supplies backgrounds extracted from the CSS palettes. */
export function themeInitScript(backgrounds: { light: string; dark: string }): string {
  return `(function(){var r=document.documentElement,t=${JSON.stringify(DEFAULT_THEME)},a=${JSON.stringify(DEFAULT_ACCENT)};try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(${JSON.stringify(THEMES)}.indexOf(s)>=0)t=s}catch(e){}try{var c=localStorage.getItem("gond-agent-accent");if(${JSON.stringify(ACCENTS)}.indexOf(c)>=0)a=c}catch(e){}var d=t==="dark"||(t==="system"&&matchMedia(${JSON.stringify(DARK_QUERY)}).matches);r.classList.toggle("dark",d);r.dataset.theme=t;r.dataset.accent=a;r.style.colorScheme=d?"dark":"light";document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",${JSON.stringify(backgrounds)}[d?"dark":"light"])})})();`;
}
