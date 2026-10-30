// Images people attach to a run's messages: pasted, dropped or picked. Large ones are scaled down
// in the browser first (models read up to about 1568px on the long side anyway), then the file is
// uploaded as is; messages carry only the uploaded image's id.
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react"
import { api } from "./api"

export interface UploadedImage {
  id: string
  media_type: string
}

export interface Attached {
  id: string
  name: string
  /** Object URL for the thumbnail. */
  url: string
  /** Set once the image is scaled and uploaded. */
  image?: UploadedImage
}

export const MAX_IMAGES = 4
const MAX_BYTES = 3_750_000
const MAX_SIDE = 1568
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const ACCEPT = TYPES.join(",")

async function scaled(file: File): Promise<Blob> {
  // GIFs keep their animation, so they're sent as is.
  if (file.type === "image/gif") return file
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name || "That image"} couldn't be read.`)
  })
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    if (k === 1 && file.size <= MAX_BYTES) return file
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bmp.width * k))
    canvas.height = Math.max(1, Math.round(bmp.height * k))
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const encode = (type: string, q?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q))
    const out = file.type === "image/png" ? await encode("image/png") : await encode("image/jpeg", 0.9)
    // A big photo-like PNG can stay over the limit; JPEG gets it under.
    if (out && out.size > MAX_BYTES) return (await encode("image/jpeg", 0.85)) ?? out
    return out ?? file
  } finally {
    bmp.close()
  }
}

async function uploadImage(file: File): Promise<UploadedImage> {
  if (!TYPES.includes(file.type)) throw new Error(`${file.name || "That file"} isn't a PNG, JPEG, GIF or WebP image.`)
  const blob = await scaled(file)
  if (blob.size > MAX_BYTES) throw new Error(`${file.name || "That image"} is too large. Images can be up to 3.75 MB.`)
  return api<UploadedImage>("/v1/images", { upload: blob })
}

/** Attachment state for one composer, plus the paste and drop handlers to spread on it. */
export function useImageAttachments() {
  const [items, setItems] = useState<Attached[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const current = useRef<Attached[]>([])
  const input = useRef<HTMLInputElement>(null)

  const update = (next: Attached[]) => {
    current.current = next
    setItems(next)
  }

  useEffect(() => () => current.current.forEach((i) => URL.revokeObjectURL(i.url)), [])

  const add = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"))
    const room = MAX_IMAGES - current.current.length
    setError(
      images.length < files.length
        ? "Only images can be attached: PNG, JPEG, GIF or WebP."
        : images.length > room
          ? `Attach up to ${MAX_IMAGES} images per message.`
          : null,
    )
    const added = images.slice(0, Math.max(0, room)).map((f) => ({ id: crypto.randomUUID(), name: f.name || "Pasted image", url: URL.createObjectURL(f), file: f }))
    if (!added.length) return
    update([...current.current, ...added.map(({ file: _, ...a }) => a)])
    for (const a of added) {
      uploadImage(a.file).then(
        (image) => update(current.current.map((i) => (i.id === a.id ? { ...i, image } : i))),
        (e: Error) => {
          remove(a.id)
          setError(e.message)
        },
      )
    }
  }

  const remove = (id: string) => {
    const gone = current.current.find((i) => i.id === id)
    if (gone) URL.revokeObjectURL(gone.url)
    update(current.current.filter((i) => i.id !== id))
  }

  const clear = () => {
    current.current.forEach((i) => URL.revokeObjectURL(i.url))
    update([])
    setError(null)
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files")

  return {
    items,
    error,
    dragging,
    /** Still scaling or uploading one of them. */
    busy: items.some((i) => !i.image),
    /** Ids of the uploaded images, for the message. */
    images: (): string[] => items.flatMap((i) => (i.image ? [i.image.id] : [])),
    remove,
    clear,
    pick: () => input.current?.click(),
    inputProps: {
      ref: input,
      type: "file" as const,
      hidden: true,
      multiple: true,
      accept: ACCEPT,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        add(Array.from(e.target.files ?? []))
        e.target.value = ""
      },
    },
    /** Spread on the composer's outer element. */
    handlers: {
      onPasteCapture: (e: ClipboardEvent) => {
        const files = Array.from(e.clipboardData.files)
        if (!files.length) return
        e.preventDefault()
        e.stopPropagation()
        add(files)
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setDragging(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setDragging(false)
        add(Array.from(e.dataTransfer.files))
      },
    },
  }
}
