import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readUtf8File, removeDirectory } from "../filesystem/index.js";

import { compileProject } from "./compileProject.js";

const temporaryDirectories: string[] = [];
const fixture = path.resolve(process.cwd(), "examples", "daimon-public-host");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("public Daimon host fixture", () => {
  it("emits one strict public host config, launcher, and pinned generic image receipt check", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-public-daimon-"));
    temporaryDirectories.push(outputDirectory);

    const result = await compileProject(fixture, { outputDirectory });
    const container = result.report.container;
    const instance = container?.runtime_instances.find((candidate) => candidate.runtime === "daimon");
    const configPath = path.join(
      outputDirectory,
      "container/rootfs/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json"
    );
    const launcherPath = path.join(
      outputDirectory,
      "container/rootfs/opt/spawnfile/runtime-installs/daimon/daimon-start.sh"
    );

    expect(container?.runtimes_installed).toEqual(["daimon"]);
    expect(instance).toMatchObject({
      config_path: "/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json",
      engine_by_node_id: { "agent:public-host-agent": "codex" },
      id: "daimon-organization",
      model_auth_methods: {},
      model_secrets_required: [],
      node_ids: ["agent:public-host-agent"]
    });
    expect(container?.moltnet).toBeUndefined();

    await expect(readUtf8File(configPath)).resolves.toContain('"version": "noopolis.daimon.organization-runtime.v1"');
    const launcher = await readUtf8File(launcherPath);
    expect(launcher).toContain("exec daimon-runtime run --config /var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json");
    expect(launcher).not.toContain("<config-path>");

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain("COPY --from=noopolis/spawnfile-runtime-daimon@sha256:");
    expect(dockerfile).toContain("capability-receipt.json");
    expect(dockerfile).toContain(
      "install -d -o root -g root -m 700 '/var/lib/spawnfile/instances/daimon/daimon-organization/runtime-homes'"
    );
    expect(dockerfile).toContain('USER root\nENTRYPOINT ["/opt/spawnfile/daimon-uid-entrypoint.sh"]');
    expect(dockerfile).not.toContain("USER spawnfile");
    expect(dockerfile).not.toContain("npm install --omit=dev --no-fund --no-audit @noopolis/daimon");
  });
});
