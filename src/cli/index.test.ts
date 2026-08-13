import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("CLI entrypoint", () => {
  it("lets buffered machine output drain before the process exits", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("process.exitCode = exitCode;");
    expect(source).not.toMatch(/process\.exit\(/u);
  });
});
