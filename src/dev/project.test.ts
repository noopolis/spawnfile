import { chmod, cp, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureDirectory,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";
import { type DeploymentRecord, writeDeploymentRecord } from "../deployment/index.js";

import { devApplyProject, devRestartProject, devStopProject, devUpProject } from "./project.js";

const fixturesRoot = path.resolve(process.cwd(), "fixtures");
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
  const cliPath = path.join(directory, "moltnet");
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

const addObserverAgent = async (projectDirectory: string): Promise<void> => {
  const rootSpawnfile = path.join(projectDirectory, "Spawnfile");
  const current = await readFile(rootSpawnfile, "utf8");
  await writeUtf8File(
    rootSpawnfile,
    current
      .replace("  - id: review\n    ref: ./teams/review", [
        "  - id: review",
        "    ref: ./teams/review",
        "  - id: observer",
        "    ref: ./agents/observer"
      ].join("\n"))
      .replace("        members: [mapper, review]", "        members: [mapper, review, observer]")
  );
  await ensureDirectory(path.join(projectDirectory, "agents", "observer"));
  await writeUtf8File(
    path.join(projectDirectory, "agents", "observer", "AGENTS.md"),
    "# Observer\n\nReply briefly and mention @mapper when asked.\n"
  );
  await writeUtf8File(
    path.join(projectDirectory, "agents", "observer", "Spawnfile"),
    [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: observer",
      'description: "Observes the Pi harness dev loop."',
      "",
      "runtime: pi",
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
      "surfaces:",
      "  moltnet:",
      "    - network: pi_lab",
      "      rooms:",
      "        lab-floor:",
      "          wake: mentions",
      "",
      "workspace:",
      "  docs:",
      "    system: AGENTS.md",
      ""
    ].join("\n")
  );
};

const addExternalObserverNetwork = async (projectDirectory: string): Promise<void> => {
  const rootSpawnfile = path.join(projectDirectory, "Spawnfile");
  await writeUtf8File(
    rootSpawnfile,
    `${await readFile(rootSpawnfile, "utf8")}\n${[
      "  - id: external_lab",
      "    name: External Lab",
      "    provider: moltnet",
      "    server:",
      "      mode: external",
      "      url: https://moltnet.example.com",
      "      auth:",
      "        mode: bearer",
      "        client:",
      "          token_env: MOLTNET_EXTERNAL_TOKEN",
      "    rooms:",
      "      - id: external-floor",
      "        members: [observer]",
      "        visibility: public",
      "        write_policy: registered_agents",
      ""
    ].join("\n")}`
  );
  const observerSpawnfile = path.join(projectDirectory, "agents", "observer", "Spawnfile");
  await writeUtf8File(
    observerSpawnfile,
    (await readFile(observerSpawnfile, "utf8")).replace(
      [
        "    - network: pi_lab",
        "      rooms:",
        "        lab-floor:",
        "          wake: mentions"
      ].join("\n"),
      [
        "    - network: pi_lab",
        "      rooms:",
        "        lab-floor:",
        "          wake: mentions",
        "    - network: external_lab",
        "      rooms:",
        "        external-floor:",
        "          wake: mentions"
      ].join("\n")
    )
  );
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
        container_name: "spawnfile-pi-dev",
        contains: [
          { id: "agent:mapper", kind: "agent" },
          { id: "agent:reviewer", kind: "agent" }
        ],
        id: "dev-container",
        image_id: "image-id",
        image_tag: "spawnfile-pi-dev",
        kind: "container",
        manager: "docker",
        runtime_instances: ["pi-app"]
      }
    ],
    version: "spawnfile.deployment.v2"
  });
};

const createMinimalPiProject = async (): Promise<string> => {
  const directory = await createTempDirectory("spawnfile-dev-minimal-");
  await writeUtf8File(path.join(directory, "AGENTS.md"), "# Solo\n\nReply briefly.\n");
  await writeUtf8File(
    path.join(directory, "Spawnfile"),
    [
      'spawnfile_version: "0.1"',
      "kind: agent",
      "name: solo",
      'description: "Minimal Pi dev agent."',
      "",
      "runtime: pi",
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
  it("hot-applies a new Pi agent and starts only its Moltnet bridge", async () => {
    const parentDirectory = await createTempDirectory("spawnfile-dev-project-");
    const projectDirectory = path.join(parentDirectory, "org");
    await cp(path.join(fixturesRoot, "e2e", "pi-harness-org"), projectDirectory, {
      recursive: true
    });
    await addObserverAgent(projectDirectory);
    process.env.SPAWNFILE_MOLTNET_CLI = await createFakeMoltnetCli();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);

    const calls: string[][] = [];
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.some((arg) => arg.endsWith("/spawnfile/agents"))) {
        return {
          stderr: "",
          stdout: JSON.stringify({
            agents: [
              { id: "agent:mapper", name: "mapper", slug: "mapper" },
              { id: "agent:reviewer", name: "reviewer", slug: "reviewer" }
            ]
          })
        };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await devApplyProject(projectDirectory, {
      agent: "observer",
      deploymentName: "dev",
      execFile,
      outputDirectory
    });

    expect(result).toMatchObject({
      agentId: "agent:observer",
      bridgeStarted: true,
      containerName: "spawnfile-pi-dev",
      existingAgent: false
    });
    expect(calls.some((args) =>
      args.join(" ").includes("pi-app.json spawnfile-pi-dev:/var/lib/spawnfile/instances/pi/pi-app/pi/pi-app.json")
    )).toBe(true);
    expect(calls.some((args) =>
      args.join(" ").includes("workspace/agents/observer spawnfile-pi-dev:/var/lib/spawnfile/instances/pi/pi-app/workspace/agents")
    )).toBe(true);
    expect(calls.some((args) =>
      args.join(" ").includes("/var/lib/spawnfile/moltnet/nodes/pi-harness-org-pi_lab-observer.json")
    )).toBe(true);
    expect(calls.some((args) =>
      args.join(" ").includes("/var/lib/spawnfile/moltnet/servers/")
    )).toBe(true);
    expect(calls.some((args) =>
      args.includes("mkdir")
      && args.includes("-p")
      && args.includes("/var/lib/spawnfile/agents/observer/state/moltnet")
    )).toBe(true);
    expect(calls.some((args) =>
      args.includes("chown")
      && args.includes("spawnfile:spawnfile")
      && args.includes("/var/lib/spawnfile/instances/pi/pi-app")
      && args.includes("/var/lib/spawnfile/moltnet/nodes/pi-harness-org-pi_lab-observer.json")
      && args.includes("/var/lib/spawnfile/agents/observer/state/moltnet")
    )).toBe(true);
    expect(calls.some((args) =>
      args.includes("--data") && args.includes(JSON.stringify({ slug: "observer" }))
    )).toBe(true);
    expect(calls.some((args) =>
      args.includes("-d")
      && args.includes("--user")
      && args.includes("spawnfile")
      && args.at(-1)?.includes("moltnet node '/var/lib/spawnfile/moltnet/nodes/pi-harness-org-pi_lab-observer.json'")
    )).toBe(true);
  }, 40_000);

  it("reloads an existing Pi agent without starting a second bridge", async () => {
    const parentDirectory = await createTempDirectory("spawnfile-dev-project-");
    const projectDirectory = path.join(parentDirectory, "org");
    await cp(path.join(fixturesRoot, "e2e", "pi-harness-org"), projectDirectory, {
      recursive: true
    });
    process.env.SPAWNFILE_MOLTNET_CLI = await createFakeMoltnetCli();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);

    const calls: string[][] = [];
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.some((arg) => arg.endsWith("/spawnfile/agents"))) {
        return {
          stderr: "",
          stdout: JSON.stringify({
            agents: [
              { id: "agent:mapper", name: "mapper", slug: "mapper" },
              { id: "agent:reviewer", name: "reviewer", slug: "reviewer" }
            ]
          })
        };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await devApplyProject(projectDirectory, {
      agent: "mapper",
      deploymentName: "dev",
      execFile,
      outputDirectory
    });

    expect(result).toMatchObject({
      agentId: "agent:mapper",
      bridgeStarted: false,
      existingAgent: true
    });
    expect(calls.some((args) => args.includes("-d"))).toBe(false);
    expect(calls.some((args) =>
      args.includes("--data") && args.includes(JSON.stringify({ slug: "mapper" }))
    )).toBe(true);
    expect(calls.some((args) => args.some((arg) => arg.endsWith("/spawnfile/agents/load")))).toBe(true);
  }, 40_000);

  it("starts all Moltnet node bridges for a new Pi agent", async () => {
    const parentDirectory = await createTempDirectory("spawnfile-dev-project-");
    const projectDirectory = path.join(parentDirectory, "org");
    await cp(path.join(fixturesRoot, "e2e", "pi-harness-org"), projectDirectory, {
      recursive: true
    });
    await addObserverAgent(projectDirectory);
    await addExternalObserverNetwork(projectDirectory);
    process.env.SPAWNFILE_MOLTNET_CLI = await createFakeMoltnetCli();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);

    const calls: string[][] = [];
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.some((arg) => arg.endsWith("/spawnfile/agents"))) {
        return { stderr: "", stdout: JSON.stringify({ agents: [] }) };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await devApplyProject(projectDirectory, {
      agent: "observer",
      deploymentName: "dev",
      execFile,
      outputDirectory
    });

    const bridgeStarts = calls.filter((args) =>
      args.includes("-d") && args.at(-1)?.includes("/usr/local/bin/moltnet node")
    );
    expect(result.bridgeStarted).toBe(true);
    expect(bridgeStarts).toHaveLength(2);
    expect(bridgeStarts.some((args) =>
      args.at(-1)?.includes("pi-harness-org-pi_lab-observer.json")
    )).toBe(true);
    expect(bridgeStarts.some((args) =>
      args.at(-1)?.includes("pi-harness-org-external_lab-observer.json")
    )).toBe(true);
  }, 40_000);

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
      containerName: "spawnfile-pi-dev",
      deploymentName: "dev",
      outputDirectory
    });
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["--host", "unix:///var/run/docker.sock", "rm", "-f", "spawnfile-pi-dev"],
      { timeout: 30_000 }
    );
  });

  it("hot-applies a Pi agent without Moltnet without starting a bridge", async () => {
    const projectDirectory = await createMinimalPiProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.some((arg) => arg.endsWith("/spawnfile/agents"))) {
        return { stderr: "", stdout: JSON.stringify({ agents: [] }) };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await devApplyProject(projectDirectory, {
      agent: "solo",
      deploymentName: "dev",
      execFile,
      outputDirectory
    });

    expect(result.bridgeStarted).toBe(false);
    expect(execFile.mock.calls.some(([, args]) => args.includes("-d"))).toBe(false);
  });

  it("requires an existing dev deployment record", async () => {
    const projectDirectory = await createMinimalPiProject();
    await expect(
      devApplyProject(projectDirectory, {
        agent: "solo",
        outputDirectory: path.join(projectDirectory, ".spawn-dev")
      })
    ).rejects.toThrow(/No dev deployment records/);
  });

  it("requires a deployment name when multiple dev records exist", async () => {
    const projectDirectory = await createMinimalPiProject();
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
    const projectDirectory = await createMinimalPiProject();
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
    const projectDirectory = await createMinimalPiProject();
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

  it("reports an unknown Pi agent after recompiling", async () => {
    const projectDirectory = await createMinimalPiProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.some((arg) => arg.endsWith("/spawnfile/agents"))) {
        return { stderr: "", stdout: JSON.stringify({ agents: [] }) };
      }
      return { stderr: "", stdout: "" };
    });

    await expect(
      devApplyProject(projectDirectory, {
        agent: "missing",
        deploymentName: "dev",
        execFile,
        outputDirectory
      })
    ).rejects.toThrow(/Pi agent "missing" was not found/);
  });

  it("uses the same hot-apply path for dev restart", async () => {
    const projectDirectory = await createMinimalPiProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory);
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args.some((arg) => arg.endsWith("/spawnfile/agents"))) {
        return {
          stderr: "",
          stdout: JSON.stringify({
            agents: [{ id: "agent:solo", name: "solo", slug: "solo" }]
          })
        };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await devRestartProject(projectDirectory, {
      agent: "solo",
      deploymentName: "dev",
      execFile,
      outputDirectory
    });

    expect(result).toMatchObject({
      agentId: "agent:solo",
      bridgeStarted: false,
      existingAgent: true
    });
    expect(execFile.mock.calls.some(([, args]) =>
      args.some((arg) => arg.endsWith("/spawnfile/agents/restart"))
    )).toBe(true);
  });

  it("uses the recorded Docker context for hot apply", async () => {
    const projectDirectory = await createMinimalPiProject();
    const outputDirectory = path.join(projectDirectory, ".spawn-dev");
    await seedDeploymentRecord(outputDirectory, projectDirectory, {
      endpoint_fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "context",
      name: "remote-dev"
    });
    const execFile = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "--context" && args[1] === "remote-dev" && args.includes("info")) {
        return { stderr: "", stdout: "x86_64\n" };
      }
      if (args.some((arg) => arg.endsWith("/spawnfile/agents"))) {
        return { stderr: "", stdout: JSON.stringify({ agents: [] }) };
      }
      return { stderr: "", stdout: "" };
    });

    const result = await devApplyProject(projectDirectory, {
      agent: "solo",
      deploymentName: "dev",
      execFile,
      outputDirectory
    });

    expect(result.bridgeStarted).toBe(false);
    expect(execFile.mock.calls.some(([, args]) =>
      args.slice(0, 2).join(" ") === "--context remote-dev"
    )).toBe(true);
  });

  it("uses the only dev record when no deployment name is provided", async () => {
    const projectDirectory = await createMinimalPiProject();
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

  it("starts a detached dev deployment in .spawn-dev by default", async () => {
    const projectDirectory = await createMinimalPiProject();
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
