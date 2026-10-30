// One-page navigation that never changes the URL: the address bar stays "/" (no "/#selfhost").
import { useEffect } from "react"

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches

/** Smooth-scrolls to the section with this id (an instant jump with reduced motion). Use from buttons, not links. */
export function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" })
}

/** Opened with an old hash link (e.g. /#selfhost): go to that section, then drop the hash from the URL. */
export function useHashlessLanding() {
  useEffect(() => {
    const id = location.hash.slice(1)
    if (!id) return
    history.replaceState(null, "", location.pathname + location.search)
    requestAnimationFrame(() => scrollToSection(id))
  }, [])
}
