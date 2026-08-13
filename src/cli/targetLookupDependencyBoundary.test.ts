import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const valueImports = (source: string): string[] =>
  [...source.matchAll(/import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gu)]
    .map((match) => match[1]!);
const resolveSource = (from: string, specifier: string): string =>
  path.resolve(path.dirname(from), specifier.replace(/\.js$/u, ".ts"));

describe("target lookup dependency boundary", () => {
  it("keeps the production lookup module graph provider-neutral", async () => {
    const pending = [
      path.join(sourceRoot, "cli", "targetCliRoute.ts"),
      path.join(sourceRoot, "cli", "targetLookupCli.ts"),
      path.join(sourceRoot, "cli", "targetLookupCommands.ts")
    ];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, "utf8");
      for (const specifier of valueImports(source)) {
        if (!specifier.startsWith(".")) continue;
        const dependency = resolveSource(file, specifier);
        expect(dependency).not.toMatch(
          /(?:docker|provider|targetDefaultAuthorities|targetDefaultHandlers|target\/index)\b/iu
        );
        pending.push(dependency);
      }
    }
    expect([...visited].map((file) => path.relative(sourceRoot, file)).sort())
      .toContain("target/journal.ts");
  });
});
