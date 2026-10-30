/** Dev only: `?open=<name>` opens that menu on load, so popovers can be screenshotted. Stripped from builds. */
export const devOpen = (name: string) =>
  import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("open") === name
