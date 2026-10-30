// Voice input for the web composer: record from the mic, encode a small
// 16 kHz mono WAV in the page (a format every speech model reads, unlike MediaRecorder's WebM), and turn it
// into text with POST /v1/transcribe. The text is handed back to be inserted, never sent.
import { useEffect, useRef, useState } from "react"

/** How each app sends the recording, and its wording where the two differ. */
export interface DictationHost {
  transcribe(wav: Blob, lang: string): Promise<string>
  unsupported: string
  denied: string
}

const RATE = 16_000
/** The API takes about 2 minutes; stop a little before. */
const MAX_SECONDS = 115

export type DictationState = "idle" | "starting" | "recording" | "transcribing"

function downsample(chunks: Float32Array[], from: number): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const input = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    input.set(c, at)
    at += c.length
  }
  const ratio = from / RATE
  const out = new Int16Array(Math.floor(total / ratio))
  for (let i = 0; i < out.length; i++) {
    // Average the source samples this output sample covers (a cheap low-pass).
    const start = Math.floor(i * ratio)
    const end = Math.min(total, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]!
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out
}

function encodeWav(samples: Int16Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  str(0, "RIFF")
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, "WAVE")
  str(12, "fmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, RATE, true)
  v.setUint32(28, RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, "data")
  v.setUint32(40, samples.length * 2, true)
  new Int16Array(buf, 44).set(samples)
  return new Blob([buf], { type: "audio/wav" })
}

interface Session {
  stream: MediaStream
  ctx: AudioContext
  node: ScriptProcessorNode
  chunks: Float32Array[]
  timer: number
}

/** Mic recording plus transcription. `onText` gets the words once they're ready. */
export function useDictation(onText: (text: string) => void, host: DictationHost) {
  const [state, setState] = useState<DictationState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const session = useRef<Session | null>(null)
  const textRef = useRef(onText)
  useEffect(() => {
    textRef.current = onText
  })

  const release = () => {
    const s = session.current
    session.current = null
    if (!s) return
    window.clearInterval(s.timer)
    s.node.disconnect()
    s.stream.getTracks().forEach((t) => t.stop())
    void s.ctx.close().catch(() => {})
  }

  useEffect(() => release, [])

  const stop = async () => {
    const s = session.current
    if (!s) return
    const { chunks, ctx } = s
    const rate = ctx.sampleRate
    release()
    const samples = downsample(chunks, rate)
    if (samples.length < RATE / 4) {
      setState("idle")
      return // under a quarter second: nothing was said
    }
    setState("transcribing")
    try {
      const lang = (navigator.language || "en").split("-")[0]!.toLowerCase()
      const text = await host.transcribe(encodeWav(samples), lang)
      if (text) textRef.current(text)
      else setError("Didn't catch anything. Try again a little closer to the mic.")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setState("idle")
    }
  }

  const start = async () => {
    if (session.current || state !== "idle") return
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(host.unsupported)
      return
    }
    setState("starting")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      // ScriptProcessor is deprecated but works everywhere without a separate worklet module.
      const node = ctx.createScriptProcessor(4096, 1, 1)
      const chunks: Float32Array[] = []
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      source.connect(node)
      node.connect(ctx.destination)
      const began = Date.now()
      const timer = window.setInterval(() => {
        const s = Math.floor((Date.now() - began) / 1000)
        setSeconds(s)
        if (s >= MAX_SECONDS) void stop()
      }, 250)
      session.current = { stream, ctx, node, chunks, timer }
      setSeconds(0)
      setState("recording")
    } catch (e) {
      release()
      setState("idle")
      const name = (e as DOMException).name
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? host.denied
          : name === "NotFoundError"
            ? "No microphone found."
            : "Couldn't start the microphone.",
      )
    }
  }

  /** Stop without transcribing. */
  const cancel = () => {
    release()
    setState("idle")
  }

  return { state, error, seconds, start, stop, cancel, toggle: () => (state === "recording" ? void stop() : void start()) }
}
