import { applyAccent, cachedAccent } from "./accent"

document.documentElement.classList.add("dark")
document.documentElement.style.colorScheme = "dark"
applyAccent(cachedAccent())
