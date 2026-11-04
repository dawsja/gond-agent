import type { PushOptions } from "../github";
import type { Run } from "./service";

/** Keep the first-publication lease and any policy guard together on every push path. */
export function publicationPushOptions(run: Pick<Run, "explicit_branch" | "pushed">, beforePush?: PushOptions["beforePush"]): PushOptions {
  return { lease: run.explicit_branch && !run.pushed ? "create-only" : undefined, beforePush };
}
