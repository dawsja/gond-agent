import { LoaderCircle } from "lucide-react"
import { AlertDialog as Dialog } from "radix-ui"
import { Button } from "@shared/ui/button"

/** A small confirm prompt: a question, a line of context, Cancel and a red confirm button. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50 bg-black/60"
          onClick={(e) => e.stopPropagation()}
        />
        <Dialog.Content
                    onClick={(e) => e.stopPropagation()}
          className="fixed top-1/2 left-1/2 z-50 w-[380px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-[4px] border border-border-strong bg-surface p-5 text-foreground"
        >
          <Dialog.Title className="text-[15px] font-semibold">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-1.5 text-[13px] text-muted-foreground">{body}</Dialog.Description>
          {error && <p className="mt-2 text-[13px] text-failed">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              autoFocus
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy && <LoaderCircle className="size-3.5 animate-spin" />}
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
