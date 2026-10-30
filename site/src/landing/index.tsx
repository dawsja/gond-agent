import { ArrowUpRight, Check, GitPullRequest, Server, ShieldCheck } from "lucide-react"
import { APP_URL, MODELS, MODELS_NOTE } from "@/content"
import { Nav } from "./nav"
import { Footer } from "./footer"
import { CloudRunReplay } from "./cloud-run"
import "./c.css"
const wrap = "mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-12"
export default function Landing() {
  return <div className="mc min-h-screen"><Nav /><main>
    <section className={`${wrap} pt-12 pb-24 lg:pt-20 lg:pb-28`}>
      <div className="mb-8 flex items-center gap-2 text-xs font-medium tracking-[0.13em] text-(--ink-2) uppercase"><span className="size-1.5 bg-(--brand)" /> Self-hosted coding agents</div>
      <h1 className="t-display max-w-[14ch]">Your next PR.<br />On your own terms.</h1>
      <div className="mt-12 grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
        <div className="pt-1"><p className="max-w-md text-xl leading-relaxed text-(--ink-2)">Give Gond Agent a task. It reads the repo, writes the change, and opens a pull request. You run the infrastructure. You review the work.</p>
          <a href={APP_URL} className="mt-8 inline-flex h-12 items-center gap-5 rounded-[3px] bg-(--ink) px-5 text-sm font-semibold text-(--paper)">Open your workspace <ArrowUpRight className="size-4" /></a>
          <p className="mt-5 text-sm text-(--ink-3)">Every feature, for every account.</p>
          <div className="mt-12 border-t border-(--rule) pt-5 text-sm text-(--ink-2)"><div className="flex items-center gap-2"><ShieldCheck className="size-4 text-(--brand)" /> Your code stays on infrastructure you control.</div></div>
        </div><CloudRunReplay className="min-w-0" />
      </div>
    </section>
    <section id="agents" className={`${wrap} border-t border-(--rule) py-20`}>
      <div className="mb-12 flex flex-wrap items-end justify-between gap-5"><h2 className="t-h2 max-w-[12ch]">From a task<br />to a pull request.</h2><p className="max-w-sm text-lg text-(--ink-2)">One place to start work, follow the changes, and decide what ships.</p></div>
      <div className="grid gap-8 md:grid-cols-3">{[
        ["01", "Pick your repository", "Connect through your host’s GitHub session. Choose a repository, describe the task, and attach a screenshot if it helps."],
        ["02", "Give it room to work", "An isolated worker reads the code, makes changes, and runs tests. Follow along or come back when it’s ready."],
        ["03", "Review what changed", "Read the diff, ask for a follow-up, and merge the pull request when you’re happy with the result."],
      ].map(([n,title,body]) => <article key={n} className="border-t border-(--rule) pt-5"><span className="font-mono text-xs text-(--brand)">{n}</span><h3 className="mt-6 text-2xl font-medium tracking-tight">{title}</h3><p className="mt-4 text-base leading-relaxed text-(--ink-2)">{body}</p></article>)}</div>
    </section>
    <section id="selfhost" className={`${wrap} grid gap-12 border-t border-(--rule) py-20 lg:grid-cols-2`}>
      <div><div className="mb-6 flex items-center gap-2 text-xs tracking-[0.13em] text-(--ink-3) uppercase"><Server className="size-4" /> Made for your server</div><h2 className="t-h2 max-w-[12ch]">The whole stack.<br />Under your roof.</h2><a href="/docs/self-hosting" className="mt-8 inline-flex items-center gap-2 text-sm underline underline-offset-4">Read the setup guide <ArrowUpRight className="size-4" /></a></div>
      <div className="space-y-0">{[
        ["Docker deployment", "Pull the published images and start with Docker Compose. Keep configuration and data in your own volumes."],
        ["Local SQLite", "Accounts, run history, images, and usage live in one local database. Simple to back up. Yours to keep."],
        ["Sign in your way", "Email and password out of the box. Add OpenID Connect from Settings for your team’s identity provider."],
        ["Every account gets everything", "All configured models, scheduled agents, GitHub automations, images, and voice input. One consistent workspace."],
      ].map(([title,body]) => <article key={title} className="flex gap-4 border-t border-(--rule) py-5"><Check className="mt-1 size-4 shrink-0 text-(--brand)" /><div><h3 className="text-lg font-medium">{title}</h3><p className="mt-2 text-sm leading-relaxed text-(--ink-2)">{body}</p></div></article>)}</div>
    </section>
    <section id="models" className={`${wrap} border-t border-(--rule) py-20`}><h2 className="t-h2">Your task. Your model.</h2><p className="mt-6 max-w-xl text-lg text-(--ink-2)">{MODELS_NOTE}</p><div className="mt-12 grid grid-cols-2 gap-x-10 md:grid-cols-4">{MODELS.map(group => <div key={group.maker} className="border-t border-(--rule) py-5"><p className="text-xs text-(--ink-3)">{group.maker}</p><p className="mt-3 text-lg">{group.models.join(" · ")}</p></div>)}</div></section>
    <section className={`${wrap} flex flex-wrap items-center justify-between gap-8 border-t border-(--rule) py-20`}><div><GitPullRequest className="mb-6 size-6 text-(--brand)" /><h2 className="t-h2">Give it your next task.</h2></div><a href={APP_URL} className="inline-flex h-12 items-center gap-5 rounded-[3px] bg-(--ink) px-5 text-sm font-semibold text-(--paper)">Open your workspace <ArrowUpRight className="size-4" /></a></section>
  </main><Footer /></div>
}
