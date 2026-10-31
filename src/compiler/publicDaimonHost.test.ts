import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "../runtime/daimon/contractManifest.js";
const LOCAL_DAIMON_IMAGE_REPOSITORY = "127.0.0.1:54321/noopolis/spawnfile-runtime-daimon";

import { resolveCompiledAgent } from "./training/index.js";
import { compileProject } from "./compileProject.js";

const temporaryDirectories: string[] = [];
const fixture = path.resolve(process.cwd(), "examples", "daimon-public-host");

afterEach(async () => {
  delete process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("public Daimon host fixture", () => {
  it("compiles a public host against the CI-published Daimon index with no local identity", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-public-daimon-"));
    temporaryDirectories.push(outputDirectory);
    await compileProject(fixture, { outputDirectory });
    const agent = await resolveCompiledAgent(outputDirectory, "public-host-agent");
    const config = JSON.parse(await readUtf8File(agent.runtimeConfig));
    expect(agent.containerPaths.workspace).toBe(config.agents[0].workspacePath);
    expect(agent.containerPaths.home).toBe(config.agents[0].runtimeHomePath);
    expect(agent.containerPaths.skillRoots).toEqual([".agents", ".codex"].map(root => `${config.agents[0].workspacePath}/${root}/skills`));
    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain("COPY --from=noopolis/spawnfile-runtime-daimon@sha256:40badb0eca3b332aa23ac8eef45f9f07e739dc51aed825ee4ca496542a3e0697 ");
    expect(dockerfile).toContain('amd64) expected="sha256:6558ccd7a9d4aa0dfc49dd5bd664002c11eea4b1e9d6bbf061a6d9b74a9b123d"');
    expect(dockerfile).toContain('arm64) expected="sha256:0c66a9d3e1bc65ac2b8b8fdb7e3c327ed026ac8e7b8c2365fdd7aabe2f74f727"');
  });

  it("compiles against an explicit local identity without changing production registry pins", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-public-daimon-local-"));
    const outputDirectory = path.join(directory, "output");
    const identityPath = path.join(directory, "identity.json");
    temporaryDirectories.push(directory);
    const digest = (character: string): string => `sha256:${character.repeat(64)}`;
    await writeUtf8File(identityPath, `${JSON.stringify({
      capability_receipt_sha256: digest("a"),
      development: {
        mode: "local-development",
        non_production: true,
        unpublished: true,
        unsigned: true
      },
      image_architecture: "amd64",
      image_config_digest: digest("b"),
      image_manifest_digest: digest("c"),
      image_reference: `${LOCAL_DAIMON_IMAGE_REPOSITORY}@${digest("c")}`,
      manifest_sha256: DAIMON_CONTRACT_MANIFEST_SHA256,
      registry_authority: "127.0.0.1:54321",
      version: "spawnfile.local-daimon-runtime-identity.v3"
    })}\n`);
    process.env.SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY = identityPath;

    await compileProject(fixture, { outputDirectory });

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain(
      `COPY --from=${LOCAL_DAIMON_IMAGE_REPOSITORY}@${digest("c")} `
    );
    expect(dockerfile).toContain(digest("a"));
    expect(dockerfile).not.toContain("sha256:40badb0eca3b332aa23ac8eef45f9f07e739dc51aed825ee4ca496542a3e0697");
    await expect((await import("node:fs/promises")).readFile(path.join(outputDirectory, "spawnfile-report.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      container: { local_daimon_runtime: { registry_authority: "127.0.0.1:54321", image_reference: `${LOCAL_DAIMON_IMAGE_REPOSITORY}@${digest("c")}` } }
    });
  });
});
