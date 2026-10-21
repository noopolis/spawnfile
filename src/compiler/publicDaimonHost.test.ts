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
    expect(dockerfile).toContain("COPY --from=noopolis/spawnfile-runtime-daimon@sha256:8ea499317850b9cd72039d1108b8b58cd0c9735256fbd7ac71d5dbe32969dea2 ");
    expect(dockerfile).toContain('amd64) expected="sha256:b68d2b27f8ec7f6237f2e2a5253fa3fc16f5555968ce82a07350ba258e659a93"');
    expect(dockerfile).toContain('arm64) expected="sha256:e3bab10df4fb65089895974e23048ebe2142f47b42ef0e939c0dd1595f3d8b94"');
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
    expect(dockerfile).not.toContain("sha256:8ea499317850b9cd72039d1108b8b58cd0c9735256fbd7ac71d5dbe32969dea2");
    await expect((await import("node:fs/promises")).readFile(path.join(outputDirectory, "spawnfile-report.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      container: { local_daimon_runtime: { registry_authority: "127.0.0.1:54321", image_reference: `${LOCAL_DAIMON_IMAGE_REPOSITORY}@${digest("c")}` } }
    });
  });
});
