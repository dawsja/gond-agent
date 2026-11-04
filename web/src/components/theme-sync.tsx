import { useLayoutEffect } from "react"
import { DEFAULT_THEME, isTheme } from "@shared/theme-preference"
import { useMe } from "@/lib/queries"
import { setTheme } from "@/lib/theme"

/** All account loads/refetches, including on a second device, replace the first-paint cache. */
export function ThemeSync() {
  const { data: me } = useMe()
  useLayoutEffect(() => {
    if (me) setTheme(isTheme(me.theme) ? me.theme : DEFAULT_THEME)
  }, [me])
  return null
}
