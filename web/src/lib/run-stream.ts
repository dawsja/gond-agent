// Live run transcript over /ws/runs/:id (protocol/README.md §3). Reconnects with `after=<last seq>`, so
// a dropped connection resumes exactly where it left off.
import { useEffect, useRef, useState } from "react"
import { runSocketUrl, type RunStatus } from "./api"
import { createTranscript, type StreamEvent, type Transcript } from "../features/run/transcript"

export interface RunInfo {
  status: RunStatus
  phase: "idle" | "booting" | "agent" | "finishing"
  seq: number
  pr: { number: number; url: string } | null
}

const EMPTY = createTranscript()([])

export function useRunStream(id: string | undefined) {
  // Keyed by run id, so switching runs never shows the previous run's events.
  const [data, setData] = useState<{ id?: string; transcript: Transcript; info: RunInfo | null }>({ transcript: EMPTY, info: null })
  const [connected, setConnected] = useState(false)
  const ws = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!id) return
    const mine = (prev: typeof data) => (prev.id === id ? prev : { id, transcript: EMPTY, info: null })
    const append = createTranscript()
    let lastSeq = 0
    let closed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    const pending: StreamEvent[] = []
    const flush = () => {
      frame = 0
      const batch = pending.splice(0)
      if (!batch.length) return
      const transcript = append(batch)
      setData(prev => ({ ...mine(prev), transcript }))
    }

    const retryLater = () => {
      if (!closed) timer = setTimeout(connect, Math.min(10_000, 1_000 * 2 ** retry++))
    }
    const connect = async () => {
      let url: string
      try {
        url = await runSocketUrl(id, lastSeq)
      } catch {
        return retryLater()
      }
      if (closed) return
      const sock = new WebSocket(url)
      ws.current = sock
      sock.onopen = () => {
        retry = 0
        setConnected(true)
      }
      sock.onmessage = (m) => {
        if (closed) return
        const ev = JSON.parse(m.data as string) as StreamEvent
        if (ev.type === "pong") return
        if (ev.type === "run.info") return setData((prev) => ({ ...mine(prev), info: ev as unknown as RunInfo }))
        if (ev.seq <= lastSeq) return
        lastSeq = ev.seq
        pending.push(ev)
        if (!frame) frame = requestAnimationFrame(flush)
      }
      sock.onclose = () => {
        if (closed) return
        setConnected(false)
        retryLater()
      }
    }
    void connect()
    const ping = setInterval(() => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send('{"type":"ping"}')
    }, 30_000)
    return () => {
      closed = true
      clearTimeout(timer)
      clearInterval(ping)
      cancelAnimationFrame(frame)
      ws.current?.close()
      ws.current = null
    }
  }, [id])

  const current = data.id === id
  return { transcript: current ? data.transcript : EMPTY, info: current ? data.info : null, connected }
}
