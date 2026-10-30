// /terms and /privacy: the Markdown in this folder, in the landing page's look.
import { useEffect } from "react"
import { GondAgentLockup } from "@/components/brand/logo"
import { Prose } from "@/lib/prose"
import "../landing/c.css"
import { Footer } from "../landing/footer"
import privacy from "./privacy.md?raw"
import terms from "./terms.md?raw"

const DOCS = { terms, privacy }

export default function Legal({ doc }: { doc: keyof typeof DOCS }) {
  useEffect(() => {
    document.title = doc === "terms" ? "Terms of Service · Gond Agent" : "Privacy Policy · Gond Agent"
  }, [doc])
  return (
    <div className="mc min-h-screen overflow-x-clip">
      <header className="mx-auto flex h-16 max-w-[90rem] items-center justify-between px-4 sm:px-8 lg:px-12">
        <a href="/" className="flex items-center gap-2.5 rounded-[2px]">
          <GondAgentLockup height={24} />
        </a>
        <a href="/" className="text-[0.9375rem] text-(--ink-2) underline-offset-4 hover:text-(--ink) hover:underline">
          Back to Gond Agent
        </a>
      </header>
      <main className="mx-auto max-w-[44rem] px-4 pt-10 pb-24 sm:px-8 sm:pt-16">
        <Prose>{DOCS[doc]}</Prose>
      </main>
      <Footer />
    </div>
  )
}
