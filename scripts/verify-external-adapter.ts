import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyExternalAcpDocker, type RunCommand } from "./verify-external-acp-docker.ts";

const fixture = fileURLToPath(new URL("../fixtures/external-runtime-adapter/", import.meta.url));

/** One installed module and one project-local module, selected by different team members. */
export async function verifyDeclaredAdapterTeam(executable: string, consumer: string, run: RunCommand): Promise<void> {
  const project = path.join(consumer, "harness-workshop");
  const output = path.join(consumer, "compiled-workshop");
  const env = { ...process.env, SPAWNFILE_HOME: path.join(consumer, "workshop-home") };
  await mkdir(path.join(project, "word-count"), { recursive: true });
  await copyFile(path.join(fixture, "Spawnfile"), path.join(project, "Spawnfile"));
  for (const file of ["AGENTS.md", "word-count/adapter.mjs", "word-count/harness.mjs"]) {
    await copyFile(path.join(fixture, file), path.join(project, file));
  }

  await run(executable, ["compile", project, "--out", output], path.dirname(consumer), env);
  await assert.rejects(run(executable, ["run", "--image", "."], project, env), /Image-mode run is not supported/u);
  await run(executable, ["validate", "."], project, env);
  const view = await run(executable, ["view"], project, env);
  assert.match(view.stdout, /counter/u);

  const config = await readFile(path.join(output, "runtimes/echo-harness/agents/echo/agent.json"), "utf8");
  assert.deepEqual(JSON.parse(config), { agent: "echo" });
  const input = path.join(output, "runtimes/word-count/agents/counter/input.txt");
  assert.equal(await readFile(input, "utf8"), "one small custom harness");
  const count = await run(process.execPath, [path.join(project, "word-count/harness.mjs"), input], consumer, env);
  assert.equal(count.stdout.trim(), "word-count: 4");
}

/** Exercise the packed SDK, installed plugin and public CLI from outside the source checkout. */
export async function verifyExternalAdapter(executable: string, consumer: string, run: RunCommand): Promise<void> {
  const project = path.join(consumer, "external-project");
  const output = path.join(project, "compiled");
  await mkdir(project);
  await copyFile(path.join(fixture, "Agentfile"), path.join(project, "Spawnfile"));
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
  await verifyDeclaredAdapterTeam(executable, consumer, run);
  const releaseDirectory = process.env.SPAWNFILE_VERIFY_ACP_RELEASE_DIR;
  if (releaseDirectory !== undefined) {
    await verifyExternalAcpDocker(executable, consumer, fixture, releaseDirectory, run);
  }
}
