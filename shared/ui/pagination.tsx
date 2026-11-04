import { useId } from "react"
import { PAGE_SIZES, pagination } from "../pagination"
import { Button } from "./button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select"

export interface PaginationProps {
  total: number
  page: number
  size: number
  busy?: boolean
  onPageChange: (page: number) => void
  onSizeChange: (size: number) => void
}

export function Pagination({ total, page, size, busy, onPageChange, onSizeChange }: PaginationProps) {
  const id = useId()
  const { start, end } = pagination(total, size, (page - 1) * size)
  return (
    <nav aria-label="Runs pagination" className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 text-[13px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <label htmlFor={id}>Rows per page</label>
        <Select value={String(size)} onValueChange={value => onSizeChange(Number(value))}>
          <SelectTrigger id={id} aria-label="Rows per page" className="h-8 w-[76px] rounded-[4px] text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-[4px]">
            {PAGE_SIZES.map(value => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" aria-live="polite" aria-atomic="true" className="mr-1 tabular-nums">{start}-{end} of {total}</span>
        <Button variant="outline" size="sm" className="rounded-[4px] text-[13px]" aria-label="Previous page" disabled={busy || page <= 1} onClick={() => onPageChange(page - 1)}>Previous</Button>
        <Button variant="outline" size="sm" className="rounded-[4px] text-[13px]" aria-label="Next page" disabled={busy || end >= total} onClick={() => onPageChange(page + 1)}>Next</Button>
      </div>
    </nav>
  )
}
