import { ImagePlus, LoaderCircle, X } from "lucide-react"
import type { Attached } from "@/lib/images"
import { MAX_IMAGES } from "@/lib/images"
import { cn } from "@/lib/utils"

/** Thumbnails of the images attached to the message being written. */
export function ImageTray({ items, onRemove, className }: { items: Attached[]; onRemove: (id: string) => void; className?: string }) {
  if (!items.length) return null
  return (
    <ul aria-label="Attached images" className={cn("flex flex-wrap gap-2", className)}>
      {items.map((i) => (
        <li key={i.id} className="group relative size-14 overflow-hidden rounded-[4px] border border-border-strong bg-raised">
          <img src={i.url} alt={i.name} className={cn("size-full object-cover", !i.image && "opacity-50")} />
          {!i.image && <LoaderCircle className="absolute inset-0 m-auto size-4 animate-spin text-foreground" aria-label="Preparing image" />}
          <button
            type="button"
            onClick={() => onRemove(i.id)}
            aria-label={`Remove ${i.name}`}
            title="Remove"
            className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-[3px] bg-background/85 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 max-md:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}

export function AttachButton({ onClick, count, disabled, className }: { onClick: () => void; count: number; disabled?: boolean; className?: string }) {
  const full = count >= MAX_IMAGES
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || full}
      aria-label="Attach images"
      title={full ? `Up to ${MAX_IMAGES} images per message` : "Attach images (or paste or drop them)"}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      <ImagePlus className="size-[18px]" />
    </button>
  )
}

/** Shown over a composer while files are dragged across it. */
export function DropHint({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[4px] border border-dashed border-primary bg-background/80 text-[13px] text-foreground">
      Drop images to attach them
    </div>
  )
}
