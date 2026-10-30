// Voice input (shared/dictation.ts) through this app's API client.
import { type DictationHost, useDictation as useSharedDictation } from "@shared/dictation"
import { api } from "./api"

export type { DictationState } from "@shared/dictation"

const host: DictationHost = {
  transcribe: async (wav, lang) => (await api<{ text: string }>(`/v1/transcribe?lang=${encodeURIComponent(lang)}`, { upload: wav })).text,
  unsupported: "Voice input isn't supported in this browser.",
  denied: "Allow microphone access in your browser to use voice input.",
}

export const useDictation = (onText: (text: string) => void) => useSharedDictation(onText, host)
