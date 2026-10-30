// Small pieces every adapter needs.
import type { ResponsesRequest } from "../wire";
import type { ModelRow } from "./types";

/** A tool call's streamed arguments as an object (a non-object becomes `{value}`, broken JSON `{_invalid_json}`). */
export function parseArgs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json.trim() || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _invalid_json: json };
  }
}

export const dataUrl = (mime: string, data: string) => `data:${mime};base64,${data}`;

/** The output limit to ask for: the caller's, never past the model's own. */
export const maxOutput = (req: ResponsesRequest, model: ModelRow) => Math.min(req.max_output_tokens ?? model.max_output, model.max_output);

/** Only replay opaque blocks to the exact model and connection that produced them. */
export function sameModel(stored: string | undefined, model: ModelRow): boolean {
  return stored === model.id || (!model.connection_id && stored === model.upstream_id);
}
