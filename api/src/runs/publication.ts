import { z } from "zod";
import { gh, type PushOptions } from "../github";
import { ApiError } from "../wire";
import type { Run } from "./service";
import { neutralizeVerification, verificationBlock } from "./evidence";

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const titleSchema = z.string().min(1).max(120).refine(
  value => !!value.trim() && !/[\r\n\u2028\u2029]/.test(value) && !controls.test(value),
  "Enter a title of up to 120 characters without newlines or control characters.",
);
export const branchSchema = z.string().regex(/^(gond-agent|feat|fix|chore|docs)\/[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9._-]{1,80}){0,3}$/).refine(
  value => !value.includes("..") && value.split("/").every(part => !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")),
  "Choose a valid, unprotected branch name.",
);
export const bodySchema = z.string().max(20000).refine(value => !controls.test(value), "Write a description of up to 20,000 characters without control characters.");

export function publicationFields(input: { title?: unknown; branch?: unknown; pr_body?: unknown }) {
  const result = z.object({ title: titleSchema.optional(), branch: branchSchema.optional(), pr_body: bodySchema.optional() }).safeParse(input);
  if (!result.success) throw new ApiError(400, "invalid_publication", "Check the title, branch and description: use a title of up to 120 characters without newlines, a valid branch, and a description of up to 20,000 characters.");
  return result.data;
}

/** Keep the first-publication lease and any policy guard together on every push path. */
export function publicationPushOptions(run: Pick<Run, "explicit_branch" | "pushed">, beforePush?: PushOptions["beforePush"]): PushOptions {
  return { lease: run.explicit_branch && !run.pushed ? "create-only" : undefined, beforePush };
}

/** The sole publication-body policy, shared by GitHub, MCP and workspace reads. */
export function descriptionFor(run: Pick<Run, "pr_body" | "summary" | "title" | "status" | "evidence">): string {
  const selected = run.pr_body ?? (!["failed", "stopped"].includes(run.status) && run.summary?.final_reply && run.summary.text ? run.summary.text : run.title);
  const body = neutralizeVerification(selected);
  return `${body ? `${body}\n\n` : ""}${verificationBlock(run.evidence)}`;
}

export async function remoteBranchExists(repo: string, branch: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const refs = await gh<{ ref: string }[]>(`repos/${repo}/git/matching-refs/heads/${branch}`, "GET", undefined, env);
  return refs.some(item => item.ref === `refs/heads/${branch}`);
}

export async function assertBranchAvailable(repo: string, branch: string, env: NodeJS.ProcessEnv, ownBranch?: string, checker = remoteBranchExists) {
  if (branch !== ownBranch && await checker(repo, branch, env))
    throw new ApiError(400, "branch_exists", "That branch already exists. Choose a new branch name.");
}
