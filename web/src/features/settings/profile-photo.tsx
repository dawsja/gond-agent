import { useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import Cropper, { type Area } from "react-easy-crop"
import "react-easy-crop/react-easy-crop.css"
import { api, type Me } from "@/lib/api"
import { useMe } from "@/lib/queries"
import { ProfileAvatar } from "@/components/profile-avatar"
import { Button } from "@shared/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@shared/ui/dialog"
import { Field, FieldLabel } from "@shared/ui/field"

async function croppedPhoto(source: string, area: Area) {
  const image = new Image()
  image.src = source
  await image.decode()
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 256
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Couldn't prepare this photo. Try another image.")
  context.beginPath(); context.arc(128, 128, 128, 0, Math.PI * 2); context.clip()
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, 256, 256)
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Couldn't prepare this photo. Try another image.")), "image/png"))
}

function PhotoCrop({ source, onClose, onSaved }: { source: string; onClose: () => void; onSaved: () => void }) {
  const [crop, setCrop] = useState({ x: 0, y: 0 }), [zoom, setZoom] = useState(1)
  const [area, setArea] = useState<Area | null>(null), [error, setError] = useState<string | null>(null)
  const save = useMutation({ mutationFn: async () => {
    if (!area || error) throw new Error(error ?? "Wait for the photo to load.")
    return api("/v1/me/photo", { method: "PUT", upload: await croppedPhoto(source, area) })
  }, onSuccess: onSaved })
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose() }}><DialogContent>
    <DialogTitle className="pr-8 text-lg font-semibold">Crop profile photo</DialogTitle>
    <DialogDescription className="text-sm text-muted-foreground">Drag to reposition, or focus the photo and use arrow keys. Zoom to fit the circle.</DialogDescription>
    <div className="relative h-64 shrink-0 overflow-hidden rounded-md bg-background" aria-label="Photo crop preview" style={{ pointerEvents: save.isPending ? "none" : undefined }}>
      <Cropper image={source} crop={crop} zoom={zoom} aspect={1} cropShape="round" showGrid={false} onCropChange={setCrop} onZoomChange={setZoom}
        onCropComplete={(_, pixels) => setArea(pixels)} cropperProps={{ "aria-label": "Reposition photo" }}
        onMediaLoaded={media => { if (media.naturalWidth * media.naturalHeight > 16_000_000) setError("Choose a photo up to 16 megapixels.") }}
        mediaProps={{ onError: () => setError("This image couldn't be opened. Choose another photo.") }} />
    </div>
    <Field><FieldLabel htmlFor="photo-zoom">Zoom</FieldLabel><input id="photo-zoom" type="range" min="1" max="3" step="0.01" value={zoom} disabled={save.isPending} onChange={e => setZoom(Number(e.target.value))} className="w-full accent-primary" /></Field>
    {(error ?? save.error?.message) && <p role="alert" className="text-sm text-failed">{error ?? save.error?.message}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={save.isPending} onClick={onClose}>Cancel</Button><Button disabled={!area || !!error || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save photo"}</Button></div>
  </DialogContent></Dialog>
}

export function ProfilePhoto() {
  const { data: me } = useMe(), qc = useQueryClient(), input = useRef<HTMLInputElement>(null)
  const reader = useRef<FileReader | null>(null)
  useEffect(() => () => reader.current?.abort(), [])
  const [source, setSource] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState("")
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["me"] }) }
  const remove = useMutation({ mutationFn: () => api<Pick<NonNullable<Me["user"]>, "image" | "has_photo">>("/v1/me/photo", { method: "DELETE" }), onSuccess: () => { refresh(); setNotice("Profile photo removed.") } })
  return <div className="flex flex-col gap-3 border-t border-border p-5">
    <div className="flex items-center gap-4"><ProfileAvatar src={me?.user?.image} size={64} /><div className="flex flex-col gap-2"><span className="text-sm font-medium">Profile photo</span><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => input.current?.click()}>{me?.user?.has_photo ? "Change photo" : "Upload photo"}</Button>{me?.user?.has_photo && <Button variant="ghost" size="sm" disabled={remove.isPending} onClick={() => { setNotice(""); remove.mutate() }}>{remove.isPending ? "Removing…" : "Remove photo"}</Button>}</div></div></div>
    <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, up to 2 MiB. Your photo is cropped to a circle and saved on this server.</p>
    <input ref={input} aria-label="Choose profile photo" type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} onChange={e => {
      const chosen = e.target.files?.[0]; e.target.value = ""; setError(null); setNotice("")
      if (!chosen) return
      if (!["image/png", "image/jpeg", "image/webp"].includes(chosen.type)) { setError("Choose a PNG, JPEG or WebP photo."); return }
      if (!chosen.size || chosen.size > 2 * 1024 * 1024) { setError("Choose a photo under 2 MiB."); return }
      reader.current?.abort()
      const next = new FileReader(); reader.current = next
      next.onerror = () => setError("This file couldn't be read. Choose another photo.")
      next.onload = () => { if (reader.current === next && typeof next.result === "string") setSource(next.result) }
      next.readAsDataURL(chosen)
    }} />
    {(error ?? remove.error?.message) && <p role="alert" className="text-sm text-failed">{error ?? remove.error?.message}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {source && <PhotoCrop source={source} onClose={() => setSource(null)} onSaved={() => { refresh(); setSource(null); setNotice("Profile photo saved.") }} />}
  </div>
}
