import type { StreamEvent } from "../wire";

interface SseRecord {
  event?: string;
  data: string;
}

/** Parse a text/event-stream body into records. Comment lines and empty data are skipped. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = undefined;
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let val = colon < 0 ? "" : line.slice(colon + 1);
          if (val.startsWith(" ")) val = val.slice(1);
          if (field === "event") event = val;
          else if (field === "data") data.push(val);
        }
      }
    }
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

const enc = new TextEncoder();

export function encodeEvent(e: StreamEvent): Uint8Array {
  return enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

export const PING = enc.encode(": ping\n\n");
