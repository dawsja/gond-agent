import { cn } from "@/lib/utils"

/** A flat on/off switch: 4px corners like every other control, orange when on. */
export function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-[4px] border transition-colors disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border-strong bg-background",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] left-[2px] size-3.5 rounded-[2px] transition-transform",
          checked ? "translate-x-4 bg-primary-foreground" : "bg-muted-foreground",
        )}
      />
    </button>
  )
}
