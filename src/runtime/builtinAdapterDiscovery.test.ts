import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("removes a disabled folder from generated registration and every compatibility surface", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "spawnfile-builtin-discovery-"));
  try {
    const conventions = ["generate-builtin-adapters.ts", "generate-adapter-legacy-exports.ts"];
    const source = fileURLToPath(new URL("../../", import.meta.url));
    const scripts = path.join(root, "scripts");
    const runtime = path.join(root, "src", "runtime");
    const omitted = path.join(runtime, "absent");
    const remaining = path.join(runtime, "present");
    await Promise.all([mkdir(omitted, { recursive: true }), mkdir(remaining, { recursive: true }), mkdir(scripts)]);
    await symlink(path.join(source, "node_modules"), path.join(root, "node_modules"), "dir");
    await Promise.all(conventions.map((entry) => cp(path.join(source, "scripts", entry), path.join(scripts, entry))));
    await Promise.all([
      writeFile(path.join(root, "package.json"), '{"type":"module"}'),
      writeFile(path.join(omitted, "registration.ts"), "export const adapter = {};"),
      writeFile(path.join(remaining, "registration.ts"), "export const adapter = {};"),
      writeFile(path.join(omitted, "legacyExports.json"),
        JSON.stringify([{ from: "format", surfaces: ["Registry", "UsageLedger"], values: ["parseExample"] }]))
    ]);

    const generate = () => run(process.execPath, ["--experimental-strip-types", path.join(scripts, conventions[0]!)]);
    const read = (file: string) => readFile(path.join(runtime, file), "utf8");
    await generate();
    expect(await read("legacyRegistry.generated.ts")).toContain('export { parseExample } from "./absent/format.js"');

    await rm(path.join(omitted, "registration.ts"));
    await generate();
    expect(await read("builtinAdapters.generated.ts")).toContain("./present/registration.js");
    expect(await read("builtinAdapters.generated.ts")).not.toContain("./absent/");
    expect(await read("legacyRegistry.generated.ts")).toContain("export {};");
    expect(await read("legacyUsageLedger.generated.ts")).toContain("export {};");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
