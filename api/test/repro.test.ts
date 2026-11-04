import { expect, it } from "vitest";
import { acceptEvidence, verificationBlock, type Evidence } from "../src/runs/evidence";

it("reports a declared bug without a red/green sequence rather than implying verification", () => {
  const block = verificationBlock({ records: [], ids: [], last_seq: 0, task: { kind: "bug", repro_plan: "local regression", skip: null } });
  expect(block).toContain("Kind: bug");
  expect(block).toContain("no failing repro recorded");
});

it("renders an explicit enumerated repro skip", () => {
  const block = verificationBlock({ records: [], ids: [], last_seq: 0, task: { kind: "bug", repro_plan: "", skip: "needs_external_service" } });
  expect(block).toContain("Repro skipped: needs_external_service");
});

import { evidenceSigningKey as key, evidenceTree as tree, signedRecord } from "./fixtures/evidence";

it("authenticates paired repros separately from checks, pins ordering beyond the rolling window, and fences tails", () => {
  const red = signedRecord({kind:{type:"repro_red",test_id:"c".repeat(64),test_files:["regression.test.js"],cases:["regression"]}, exit_code:1, output_tail:"AssertionError: expected 1 to be 2\n```\u202eforged"});
  let state = acceptEvidence(undefined,red,key,"run")!;
  expect(state).toBeDefined();
  const green = signedRecord({seq:2,id:"00000000-0000-4000-8000-000000000002",kind:{...red.kind,type:"repro_green"} as any,output_tail:"Passed: regression"});
  expect(acceptEvidence(undefined,green,key,"run")).toBeUndefined();
  state=acceptEvidence(state,green,key,"run")!;
  for(let seq=3;seq<=50;seq++) state=acceptEvidence(state,signedRecord({seq,id:`00000000-0000-4000-8000-${seq.toString().padStart(12,"0")}`}),key,"run")!;
  expect(state.records).toHaveLength(40);
  expect(state.records.slice(0,2)).toEqual([red,green]);
  const block=verificationBlock({...state,task:{kind:"bug",repro_plan:"regression",skip:null},publication_tree:tree,ui_required:false,staging:"tests_first"});
  expect(block).toContain("repro_red command and test id:");
  expect(block).toContain("Passing tail:");
  expect(block).toContain("Commit ordering: tests first, then fix.");
  expect(block).not.toContain("no failing repro recorded");
  expect(block).not.toContain("\u202e");
  // Green on another publication tree must not look verified.
  expect(verificationBlock({...state,task:{kind:"bug",repro_plan:"",skip:null},publication_tree:"d".repeat(40)})).toContain("no matching fresh passing repro recorded");
});

it("rejects inconclusive and infrastructure repro records, unknown fields, and a mismatched green id", () => {
  const kind = {type:"repro_red" as const,test_id:"c".repeat(64),test_files:["regression.test.js"],cases:["regression"]};
  for(const code of [0,124,126,127,137,null]) expect(acceptEvidence(undefined,signedRecord({kind,exit_code:code}),key,"run")).toBeUndefined();
  for(const patch of [{duration_ms:120000},{env_clean:false},{command_definition_changed:true},{tests_ran:0},{tree_hash_after:"d".repeat(40)}])
    expect(acceptEvidence(undefined,signedRecord({kind,exit_code:1,...patch}),key,"run")).toBeUndefined();
  const state=acceptEvidence(undefined,signedRecord({kind,exit_code:1}),key,"run")!;
  expect(acceptEvidence(state,signedRecord({seq:2,id:"00000000-0000-4000-8000-000000000002",kind:{...kind,type:"repro_green",test_id:"d".repeat(64)}}),key,"run")).toBeUndefined();
  expect(acceptEvidence(undefined,signedRecord({kind:{...kind,extra:true} as any,exit_code:1}),key,"run")).toBeUndefined();
});

it("feature declarations do not acquire a bug repro requirement", () => {
  const evidence: Evidence = {records:[],ids:[],last_seq:0,task:{kind:"feature",repro_plan:"",skip:null}};
  expect(verificationBlock(evidence)).toContain("Kind: feature");
  expect(verificationBlock(evidence)).not.toContain("no failing repro recorded");
});
