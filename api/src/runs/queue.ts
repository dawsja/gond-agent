import type { Store } from "../db";
import { ApiError } from "../wire";

interface Entry { id: string; user_id: string; queue_seq: number; queued_at: number }

/** SQLite owns membership/order; no in-memory copy of pending work or account totals. */
export class RunQueue {
  constructor(private db: Store) {}
  waiting(): Entry[] {
    return this.db.prepare("SELECT id,user_id,queue_seq,queued_at FROM runs WHERE status='queued' AND queue_seq IS NOT NULL AND deleted_at IS NULL ORDER BY queue_seq").all() as Entry[];
  }
  info(id: string, user: string) {
    const own = this.waiting().filter(r => r.user_id === user);
    const index = own.findIndex(r => r.id === id);
    return index < 0 ? {} : { queue_position: index + 1, queue_length: own.length };
  }
  has(id: string) { return this.waiting().some(r => r.id === id); }
  check(user: string, max: number, perAccount: number) {
    const rows = this.waiting();
    if (rows.length >= max || rows.filter(r => r.user_id === user).length >= perAccount)
      throw new ApiError(429, "queue_full", "Too many runs are waiting. Try again later.");
  }
  join(id: string) {
    if (this.has(id)) return;
    const { seq } = this.db.prepare("UPDATE run_queue_counter SET seq=seq+1 WHERE id=1 RETURNING seq").get() as { seq: number };
    this.db.prepare("UPDATE runs SET queue_seq=?,queued_at=? WHERE id=?").run(seq, Date.now(), id);
  }
  leave(id: string) { this.db.prepare("UPDATE runs SET queue_seq=NULL,queued_at=NULL WHERE id=?").run(id); }
  claim(id: string) {
    return this.db.prepare("UPDATE runs SET queue_seq=NULL,queued_at=NULL,status='working' WHERE id=? AND queue_seq IS NOT NULL AND status='queued' AND deleted_at IS NULL").run(id).changes === 1;
  }
  /** Fewest occupied workspaces first; oldest account head breaks ties, FIFO within each account. */
  first(occupied: Map<string, number>, reserved: Set<string>) {
    const seen = new Set<string>();
    const heads = this.waiting().filter(entry => {
      if (seen.has(entry.user_id)) return false;
      seen.add(entry.user_id);
      return !reserved.has(entry.id);
    });
    return heads.reduce<Entry | undefined>((best, entry) =>
      !best || (occupied.get(entry.user_id) ?? 0) < (occupied.get(best.user_id) ?? 0) ? entry : best, undefined);
  }
}
