import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyExternalAcpDocker, type RunCommand } from "./verify-external-acp-docker.ts";

/** Exercise the packed SDK, installed plugin and public CLI from outside the source checkout. */
export async function verifyExternalAdapter(executable: string, consumer: string, run: RunCommand): Promise<void> {
  const fixture = fileURLToPath(new URL("../fixtures/external-runtime-adapter/", import.meta.url));
  const project = path.join(consumer, "external-project");
  const output = path.join(project, "compiled");
  await mkdir(project);
  await copyFile(path.join(fixture, "Spawnfile"), path.join(project, "Spawnfile"));
  await copyFile(path.join(fixture, "adapter.mjs"), path.join(project, "adapter.mjs"));

  const packed = await run("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", project, fixture], consumer);
  await run("npm", ["install", "--offline", "--no-save", "--ignore-scripts", "--no-fund", "--no-audit",
    path.join(project, packed.stdout.trim())], consumer);

  await assert.rejects(run(executable, ["validate", "."], project), /Unknown runtime binding: echo-harness/u);
  await run(executable, ["--adapter", "./adapter.mjs", "validate", "."], project);
  await run(executable, ["--adapter", "@spawnfile-fixtures/echo-adapter", "compile", ".", "--out", output], project);
  const config = await readFile(path.join(output, "runtimes/echo-harness/agents/echo/agent.json"), "utf8");
  assert.deepEqual(JSON.parse(config), { agent: "echo" });
  assert.match(await readFile(path.join(output, "Dockerfile"), "utf8"), /COPY --from=spawnfile-fixture\/echo-harness:1\.0\.0/u);
  const releaseDirectory = process.env.SPAWNFILE_VERIFY_ACP_RELEASE_DIR;
  if (releaseDirectory !== undefined) {
    await verifyExternalAcpDocker(executable, consumer, fixture, releaseDirectory, run);
  }
}
