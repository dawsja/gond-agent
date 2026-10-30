import { LoaderCircle } from "lucide-react"
export function Activity({ label }: { label: string }) {
  return <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin text-warning motion-reduce:animate-none" /><span>{label}</span></div>
}
