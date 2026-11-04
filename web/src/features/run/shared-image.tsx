import { useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@shared/ui/dialog"
import { useRunImage } from "@/lib/queries"

/** Uses the same owner-authenticated bytes and consumer-owned URL as tool images. */
export function SharedImage({ runId, imageId, caption }: { runId: string; imageId: string; caption: string }) {
  const { data: url, isError } = useRunImage(runId, imageId)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const alt = caption || "Shared image"
  return <figure className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-card">
    {url ? <button ref={trigger} type="button" aria-label={`Enlarge image: ${alt}`} onClick={() => setOpen(true)} className="block w-full cursor-zoom-in rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <img src={url} alt={alt} className="mx-auto max-h-96 max-w-full object-contain" />
    </button> : <p role="status" className="p-4 text-sm text-muted-foreground">{isError ? "Image unavailable" : "Loading image…"}</p>}
    {caption && <figcaption className="break-words border-t border-border px-3 py-2 text-sm text-muted-foreground">{caption}</figcaption>}
    <Dialog open={open && !!url} onOpenChange={setOpen}>
      <DialogContent className="max-w-6xl" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}>
        <DialogTitle className="break-words pr-8 text-sm font-medium">{alt}</DialogTitle>
        {url && <img src={url} alt={alt} className="max-h-[75dvh] max-w-full object-contain" />}
      </DialogContent>
    </Dialog>
  </figure>
}
