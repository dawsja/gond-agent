// Every dropdown menu (the web app's profile and run menus): Radix's dropdown
// menu styled like the composer's repository and model pickers. Flat, 4px corners, 32px rows, no motion.
import { Check, ChevronRight } from "lucide-react"
import { DropdownMenu } from "radix-ui"
import type { ComponentProps } from "react"
import { cn } from "./utils"

export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger
export const MenuSub = DropdownMenu.Sub

const surface = "z-50 min-w-[8rem] overflow-hidden rounded-[4px] border border-border-strong bg-popover p-1 text-foreground outline-none"
const item =
  "flex h-8 w-full cursor-default select-none items-center gap-2 rounded-[3px] px-2 text-[13px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-raised [&_svg]:shrink-0"

export function MenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content sideOffset={sideOffset} className={cn(surface, className)} {...props} />
    </DropdownMenu.Portal>
  )
}

export function MenuItem({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cn(item, className)} {...props} />
}

/** A row that opens a submenu to its side, with the chevron the pickers use. */
export function MenuSubTrigger({ className, children, ...props }: ComponentProps<typeof DropdownMenu.SubTrigger>) {
  return (
    <DropdownMenu.SubTrigger className={cn(item, "data-[state=open]:bg-raised", className)} {...props}>
      {children}
      <ChevronRight className="ml-auto size-3.5 text-muted-foreground" />
    </DropdownMenu.SubTrigger>
  )
}

/** Opens beside its row with a gap (never touching the menu), its first row level with the trigger. */
export function MenuSubContent({ className, sideOffset = 8, alignOffset = -5, ...props }: ComponentProps<typeof DropdownMenu.SubContent>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent sideOffset={sideOffset} alignOffset={alignOffset} className={cn(surface, className)} {...props} />
    </DropdownMenu.Portal>
  )
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cn("px-2 pt-2 pb-1 text-[11px] text-subtle", className)} {...props} />
}

/** The pickers' checkmark: shown on the chosen row, kept in place (invisible) on the others. */
export function MenuCheck({ on }: { on: boolean }) {
  return <Check className={cn("ml-auto size-3.5 text-foreground", !on && "invisible")} />
}

export const MenuRadioGroup = DropdownMenu.RadioGroup

/** A choice in a radio group, checked like the pickers' rows. */
export function MenuRadioItem({ className, children, ...props }: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem className={cn(item, "group", className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Check className="ml-auto size-3.5 text-foreground opacity-0 group-data-[state=checked]:opacity-100" />
    </DropdownMenu.RadioItem>
  )
}
