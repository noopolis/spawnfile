import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { verifyDeclaredAdapterTeam } from "./verify-external-adapter.ts";

const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const fixture = new URL("../fixtures/external-runtime-adapter/", import.meta.url);

test("a trusted team compiles and runs custom harness input from two declared adapters", { timeout: 90_000 }, async () => {
  const consumer = await mkdtemp(path.join(tmpdir(), "spawnfile-harness-team-"));
  try {
    // Exercise the source CLI and its public SDK even when dist has not been built.
    const sdk = path.join(consumer, "node_modules/spawnfile");
    const echo = path.join(consumer, "node_modules/@spawnfile-fixtures/echo-adapter");
    await Promise.all([mkdir(sdk, { recursive: true }), mkdir(echo, { recursive: true })]);
    const source = new URL("../src/runtime/adapterPublic.ts", import.meta.url);
    await writeFile(path.join(sdk, "package.json"), JSON.stringify({ exports: { "./adapter": "./adapter.mjs" } }));
    await writeFile(path.join(sdk, "adapter.mjs"), `export * from ${JSON.stringify(source.href)};\n`);
    for (const file of ["package.json", "adapter.mjs"]) {
      await copyFile(new URL(file, fixture), path.join(echo, file));
    }

    await verifyDeclaredAdapterTeam(entrypoint, consumer, (command, args, cwd, env) =>
      command === entrypoint
        ? execute(process.execPath, ["--import", import.meta.resolve("tsx"), entrypoint, ...args], { cwd, env, timeout: 30_000 })
        : execute(command, args, { cwd, env, timeout: 30_000 }));
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
});
