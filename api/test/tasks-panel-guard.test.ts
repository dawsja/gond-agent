import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

it("keeps the removed pinned Tasks panel out of the web sources", () => {
  const root = fileURLToPath(new URL("../../web/src/", import.meta.url));
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    expect(entry.name).not.toBe("tasks-panel.tsx");
    expect(readFileSync(join(entry.parentPath, entry.name), "utf8"), entry.name).not.toContain("TasksPanel");
  }
});
