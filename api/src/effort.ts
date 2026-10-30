import { ApiError, type Effort } from "./wire";
import type { ModelRow } from "./adapters/types";
export const efforts = ["default", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export function supportedEfforts(model: Pick<ModelRow, "capabilities">): string[] {
  if(!model.capabilities.reasoning || model.capabilities.reasoning === "none")return [];
  return model.capabilities.efforts ?? (model.capabilities.reasoning === "budget" ? ["off", "low", "medium", "high"] : ["low", "medium", "high"]);
}
export function validateEffort(model: Pick<ModelRow, "capabilities">, value: unknown = "default"): Effort {
  if (value !== "default" && (typeof value !== "string" || !supportedEfforts(model).includes(value)))
    throw new ApiError(400, "invalid_effort", "Choose an effort supported by this model.");
  return value as Effort;
}

/** Conservative defaults for documented model families; custom models use overrides. */
export function knownReasoning(format: string, id: string): {reasoning:"none"|"adaptive"|"budget"|"effort";efforts?:Exclude<Effort,"default">[]} {
  if(format === "anthropic") {
    if(/^claude-(opus|sonnet)-(4-[67]|5)(-|$)/.test(id))return {reasoning:"adaptive",efforts:["low","medium","high",...(id.includes("opus")?["max" as const]:[])]};
    if(/^claude-(sonnet-4-5|opus-4-[015]|3-7-sonnet)(-|$)/.test(id))return {reasoning:"budget",efforts:["off","low","medium","high"]};
  } else {
    if(/-(chat-latest|pro)(-|$)/.test(id))return {reasoning:"none"};
    if(/^gpt-5\.1(-|$)/.test(id))return {reasoning:"effort",efforts:["low","medium","high"]};
    if(/^(o[134](-|$)|gpt-5(-|$))/.test(id))return {reasoning:"effort",efforts:["low","medium","high"]};
    if(/^gpt-5\.[2-6](-|$)/.test(id))return {reasoning:"effort",efforts:["low","medium","high","xhigh"]};
    if(/^gpt-6(?:\.[0-9]+)?-(astra|sol|terra|luna)(-|$)/.test(id))return {reasoning:"effort",efforts:["low","medium","high","xhigh","max"]};
  }
  return {reasoning:"none"};
}
