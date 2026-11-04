import { ArrowDown } from "lucide-react"
import { Button } from "@shared/ui/button"
import { cn } from "@/lib/utils"

export function ScrollToBottomButton({ shown, onClick }: { shown: boolean; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Scroll to bottom"
      aria-hidden={!shown}
      inert={!shown}
      tabIndex={shown ? 0 : -1}
      onMouseDown={(event) => {
        // Pointer activation should not blur a draft; keyboard activation stays native.
        if (document.activeElement instanceof HTMLTextAreaElement) event.preventDefault()
      }}
      onClick={onClick}
      style={{ bottom: "calc(var(--composer-h, 0px) + 8px)" }}
      className={cn(
        "absolute left-1/2 z-20 -translate-x-1/2 rounded-[4px] border-border-strong bg-raised text-foreground shadow-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring transition-[translate,scale,opacity] motion-reduce:transition-opacity motion-reduce:translate-y-0 motion-reduce:scale-100",
        shown ? "translate-y-0 scale-100 opacity-100 duration-200 ease-out" : "pointer-events-none translate-y-2 scale-95 opacity-0 duration-400 ease-in",
      )}
    >
      <ArrowDown aria-hidden="true" />
    </Button>
  )
}
