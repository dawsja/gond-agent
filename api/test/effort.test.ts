import { describe,it,expect } from "vitest";
import { knownReasoning, supportedEfforts, validateEffort } from "../src/effort";
import { anthropic } from "../src/adapters/anthropic";
import { chatAdapter as chat } from "../src/adapters/chat";
import { responsesAdapter as responses } from "../src/adapters/responses";
import type { ModelRow } from "../src/adapters/types";
const model:ModelRow={id:"c:m",provider:"openai",upstream_id:"m",display_name:"M",context_window:128000,max_output:32000,capabilities:{reasoning:"effort",efforts:["low","high","xhigh"]},input_micros:0,output_micros:0,cache_read_micros:0,cache_write_micros:0};
describe("model effort",()=>{
 it("rejects unsupported and malformed explicit effort",()=>{
   expect(validateEffort(model,undefined)).toBe("default");
   expect(validateEffort(model,"xhigh")).toBe("xhigh");
   for(const effort of ["none","ultra",null,{},9])expect(()=>validateEffort(model,effort)).toThrow(/supported/);
   expect(supportedEfforts({capabilities:{reasoning:"none"}})).toEqual([]);
 });
 it("keeps unknown discovered models at provider defaults",()=>{
   expect(knownReasoning("openai","custom-reasoner")).toEqual({reasoning:"none"});
   expect(knownReasoning("openai-responses","gpt-5.4").efforts).toContain("xhigh");
 });
 it("omits default effort and forwards explicit effort in each API format",()=>{
   const request={model:model.id,messages:[{role:"user" as const,content:[{type:"text" as const,text:"go"}]}]};
   expect((responses.build({...request,reasoning:{effort:"default"}},model).body as any).reasoning).toBeUndefined();
   expect((chat.build({...request,reasoning:{effort:"xhigh"}},model).body as any).reasoning_effort).toBe("xhigh");
   const adaptive={...model,provider:"anthropic" as const,capabilities:{reasoning:"adaptive" as const}};
   expect((anthropic.build({...request,reasoning:{effort:"default"}},adaptive).body as any).output_config).toBeUndefined();
   expect((anthropic.build({...request,reasoning:{effort:"high"}},adaptive).body as any).output_config.effort).toBe("high");
 });
});
