import { describe, expect, it } from "vitest";
import { modelDisplayName } from "../../shared/model-names";

describe("names from live model metadata", () => {
  it.each([
    ["New family","future","claude-new-family-10-23","Claude New Family 10.23"],
    ["Default (recommended)","default","claude-sonnet-8-12","Claude Sonnet 8.12 (default)"],
    ["Sonnet","sonnet[1m]","claude-sonnet-8-12[1m]","Claude Sonnet 8.12[1m]"],
    ["Legacy","legacy","claude-3-7-sonnet-20250219","Claude Sonnet 3.7"],
    ["Opus","opus",undefined,"Opus"],
    ["My deployment","custom","organization/model-42","organization/model-42"],
    ["GPT-6 Sol","gpt-6-sol","gpt-6-sol","GPT-6 Sol"],
    ["Claude Sonnet 8.12","claude-sonnet-8-12",undefined,"Claude Sonnet 8.12"],
    ["Sonnet","anthropic/claude-sonnet-8.12",undefined,"Claude Sonnet 8.12"],
    ["claude-sonnet-8-12","claude-sonnet-8-12",undefined,"Claude Sonnet 8.12"],
    ["Production 1","claude-sonnet-8-12",undefined,"Production 1 (Claude Sonnet 8.12)"],
    ["My custom model","organization/proxy-alias",undefined,"My custom model"],
  ])("renders %s using %s / %s",(name,id,resolved,expected)=>expect(modelDisplayName(name!,id!,resolved)).toBe(expected));
});
