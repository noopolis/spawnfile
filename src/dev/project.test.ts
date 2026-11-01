import { chmod, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../compiler/moltnetBinaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compiler/moltnetBinaries.js")>();
  const { stageTrustedTestMoltnetRelease } = await import(
    "../../fixtures/support/trustedMoltnetRelease.js"
  );
  return {
    ...actual,
    stageMoltnetBinaries: (outputDirectory: string, options: Parameters<
      typeof actual.stageMoltnetBinaries
    >[1]) => stageTrustedTestMoltnetRelease(outputDirectory, options)
  };
});

import {
  ensureDirectory,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import { type DeploymentRecord, writeDeploymentRecord } from "../deployment/index.js";

import { devActivityProject, devApplyProject, devRestartProject, devStopProject, devUpProject } from "./index.js";

const temporaryDirectories: string[] = [];
const previousMoltnetCli = process.env.SPAWNFILE_MOLTNET_CLI;
const previousOpenAIKey = process.env.OPENAI_API_KEY;

const createTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const createFakeMoltnetCli = async (): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-dev-moltnet-");
  const cliPath = path.join(directory, "moltnet.cjs");
  await writeUtf8File(
    cliPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'version') process.exit(0);",
      "if (args[0] === 'skill' && args[1] === 'install') {",
      "  const runtime = args[args.indexOf('--runtime') + 1];",
      "  const workspace = args[args.indexOf('--workspace') + 1];",
      "  const targets = runtime === 'codex'",
      "    ? [path.join(workspace, '.agents/skills/moltnet/SKILL.md'), path.join(workspace, '.codex/skills/moltnet/SKILL.md')]",
      "    : [path.join(workspace, 'skills/moltnet/SKILL.md')];",
      "  for (const target of targets) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '# Moltnet\\n'); }",
      "  process.exit(0);",
      "}",
      "process.exit(1);"
    ].join("\n") + "\n"
  );
  await chmod(cliPath, 0o755);
  return cliPath;
};

const seedDeploymentRecord = async (
  outputDirectory: string,
  projectDirectory: string,
  target: DeploymentRecord["target"] = { kind: "host", value: "unix:///var/run/docker.sock" }
): Promise<void> => {
  await writeDeploymentRecord(outputDirectory, {
    auth_profile: "dev",
    compile_fingerprint: "sf1:test",
    created_at: "2026-06-21T00:00:00.000Z",
    manager: "docker",
    name: "dev",
    output_directory: outputDirectory,
    source: { kind: "project", root: path.join(projectDirectory, "Spawnfile") },
    target,
    units: [
      {
        container_id: "container-id",
        container_name: "spawnfile-openclaw-dev",
        contains: [
          { id: "agent:mapper", kind: "agent" },
          { id: "agent:reviewer", kind: "agent" }
        ],
        id: "dev-container",
        image_id: "image-id",
        image_tag: "spawnfile-openclaw-dev",
        kind: "container",
        manager: "docker",
        runtime_instances: ["agent-assistant"]
      }
    ],
    version: "spawnfile.deployment.v2"
  });
};

const createMinimalProject = async (): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-dev-minimal-");
  await writeUtf8File(path.join(directory, "AGENTS.md"), "# Solo\n\nReply briefly.\n");
  await writeUtf8File(
    path.join(directory, "Spawnfile"),
    [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: solo",
      'description: "Minimal dev agent."',
      "",
      "runtime: openclaw",
      "",
      "execution:",
      "  model:",
      "    primary:",
      "      provider: openai",
      "      name: gpt-5.4-mini",
      "      auth:",
      "        method: codex",
      "  sandbox:",
      "    mode: workspace",
      "",
      "workspace:",
      "  docs:",
      "    system: AGENTS.md",
      ""
    ].join("\n")
  );
  return directory;
};

afterEach(async () => {
  if (previousMoltnetCli === undefined) {
    delete process.env.SPAWNFILE_MOLTNET_CLI;
  } else {
    process.env.SPAWNFILE_MOLTNET_CLI = previousMoltnetCli;
  }
  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("devApplyProject", () => {

  it("stops the recorded dev deployment container", async () => {
    const projectDirectory = await createTempDirectory("spawnfile-dev-stop-");
    await writeUtf8File(
      path.join(projectDirectory, "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: team", "name: dev-stop", ""].join("\n")
    );
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));

    const result = await devStopProject(projectDirectory, {
      deploymentName: "dev",
      execFile,
      outputDirectory
    });

    expect(result).toEqual({
      containerName: "spawnfile-openclaw-dev",
      deploymentName: "dev",
      outputDirectory
    });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--host", "unix:///var/run/docker.sock", "rm", "-f", "spawnfile-openclaw-dev"],
      { timeout: 30_000 }
    );
  });

  it("requires an existing dev deployment record", async () => {
    const projectDirectory = await createMinimalProject();
    await expect(
      devApplyProject(projectDirectory, {
        agent: "solo",
        outputDirectory: path.join(projectDirectory, ".spawn-dev")
      })
    ).rejects.toThrow(/No dev deployment records/);
  });

  it("requires a deployment name when multiple dev records exist", async () => {
    const projectDirectory = await createMinimalProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const devRecord = JSON.parse(
      await readFile(path.join(outputDirectory, "deployments", "dev.json"), "utf8")
    ) as { name: string };
    await writeDeploymentRecord(outputDirectory, {
      ...devRecord,
      name: "qa"
    } as Parameters<typeof writeDeploymentRecord>[1]);

    await expect(
      devStopProject(projectDirectory, { outputDirectory })
    ).rejects.toThrow(/--deployment is required/);
  });

  it("reports an unknown selected deployment", async () => {
    const projectDirectory = await createMinimalProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);

    await expect(
      devStopProject(projectDirectory, {
        deploymentName: "missing",
        outputDirectory
      })
    ).rejects.toThrow(/Unknown dev deployment/);
  });

  it("reports a deployment record without a container name", async () => {
    const projectDirectory = await createMinimalProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const devRecord = JSON.parse(
      await readFile(path.join(outputDirectory, "deployments", "dev.json"), "utf8")
    ) as Parameters<typeof writeDeploymentRecord>[1];
    await writeDeploymentRecord(outputDirectory, {
      ...devRecord,
      units: [{ ...devRecord.units[0]!, container_name: null }]
    });

    await expect(
      devStopProject(projectDirectory, {
        deploymentName: "dev",
        outputDirectory
      })
    ).rejects.toThrow(/no recorded container name/);
  });

  it("uses the only dev record when no deployment name is provided", async () => {
    const projectDirectory = await createMinimalProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const execFile = vi.fn(async () => ({ stderr: "", stdout: "" }));

    await expect(
      devStopProject(projectDirectory, {
        execFile,
        outputDirectory
      })
    ).resolves.toMatchObject({ deploymentName: "dev" });
  });

  it("reads the Pi activity buffer from the running dev container", async () => {
    const projectDirectory = await createMinimalProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      expect(args).toEqual([
        "--host",
        "unix:///var/run/docker.sock",
        "exec",
        "spawnfile-openclaw-dev",
        "curl",
        "-fsS",
        "http://127.0.0.1:19690/spawnfile/activity?agent=mapper&tail=5"
      ]);
      return {
        stderr: "",
        stdout: JSON.stringify({
          events: [
            {
              agent_id: "agent:mapper",
              sequence: 1,
              type: "agent.turn.started",
              version: "spawnfile.activity.v1"
            }
          ]
        })
      };
    });

    await expect(devActivityProject(projectDirectory, {
      agent: "mapper",
      deploymentName: "dev",
      execFile,
      outputDirectory,
      tail: 5
    })).resolves.toMatchObject({
      containerName: "spawnfile-openclaw-dev",
      deploymentName: "dev",
      events: [
        expect.objectContaining({
          agent_id: "agent:mapper",
          type: "agent.turn.started"
        })
      ],
      outputDirectory
    });
  });

  it("rejects malformed Pi activity endpoint responses", async () => {
    const projectDirectory = await createMinimalProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const execFile = vi.fn(async () => ({
      stderr: "",
      stdout: JSON.stringify({ status: "ok" })
    }));

    await expect(devActivityProject(projectDirectory, {
      deploymentName: "dev",
      execFile,
      outputDirectory
    })).rejects.toThrow(/events array/);
  });

  it("starts a detached dev deployment in .spawn-dev by default", async () => {
    const projectDirectory = await createMinimalProject();
    const spawnfilePath = path.join(projectDirectory, "Spawnfile");
    await writeUtf8File(
      spawnfilePath,
      (await readFile(spawnfilePath, "utf8")).replace("method: codex", "method: api_key")
    );
    process.env.OPENAI_API_KEY = "test-openai-key";
    const buildRunner = vi.fn(async () => undefined);
    const runRunner = vi.fn(async () => ({
      containerId: "container-id",
      imageId: "image-id"
    }));
    const targetExecFile = vi.fn(async () => ({
      stderr: "",
      stdout: "\"unix:///var/run/docker.sock\"\n"
    }));

    const result = await devUpProject(projectDirectory, {
      buildRunner,
      deploymentName: "dev",
      imageTag: "spawnfile-dev-test",
      runRunner,
      targetExecFile
    });

    expect(result.outputDirectory).toBe(path.join(projectDirectory, ".spawn-dev"));
    expect(result.deploymentRecordPath).toBe(
      path.join(projectDirectory, ".spawn-dev", "deployments", "dev.json")
    );
    expect(buildRunner).toHaveBeenCalled();
    expect(runRunner).toHaveBeenCalledWith(expect.objectContaining({
      detach: true,
      deploymentName: "dev",
      imageTag: "spawnfile-dev-test"
    }));
  });
});
