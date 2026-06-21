import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";

import { compileProject } from "./compileProject.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

const createFakeMoltnetCli = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-mixed-moltnet-cli-"));
  temporaryDirectories.push(directory);
  const cliPath = path.join(directory, "moltnet");
  await writeUtf8File(
    cliPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'version') { process.stdout.write('0.0.0-test\\n'); process.exit(0); }",
      "if (args[0] === 'skill' && args[1] === 'install') {",
      "  const flags = new Map();",
      "  for (let index = 2; index < args.length; index += 2) flags.set(args[index], args[index + 1]);",
      "  const runtime = flags.get('--runtime');",
      "  const workspace = flags.get('--workspace');",
      "  const targets = runtime === 'codex'",
      "    ? [path.join(workspace, '.agents', 'skills', 'moltnet', 'SKILL.md'), path.join(workspace, '.codex', 'skills', 'moltnet', 'SKILL.md')]",
      "    : [path.join(workspace, 'skills', 'moltnet', 'SKILL.md')];",
      "  for (const target of targets) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '# Moltnet\\n'); }",
      "  process.stdout.write(`${targets.join(', ')}\\n`);",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected args: ${args.join(' ')}\\n`);",
      "process.exit(1);"
    ].join("\n") + "\n"
  );
  await chmod(cliPath, 0o755);
  return cliPath;
};

const createFakeMoltnetReleaseDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-mixed-moltnet-release-"));
  temporaryDirectories.push(directory);
  const payloadDirectory = path.join(directory, "payload");
  await ensureDirectory(payloadDirectory);
  await writeUtf8File(path.join(payloadDirectory, "moltnet"), "#!/usr/bin/env sh\necho moltnet\n");
  await chmod(path.join(payloadDirectory, "moltnet"), 0o755);
  const assetName = `moltnet_linux_${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
  await execFile("tar", ["-C", payloadDirectory, "-czf", path.join(directory, assetName), "."]);
  await writeUtf8File(path.join(directory, "checksums.txt"), `${"0".repeat(64)}  ${assetName}\n`);
  return directory;
};

describe("mixed runtime org fixture", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
  });

  it("compiles OpenClaw, PicoClaw, and Daimon agents into one container plan", async () => {
    const previousCli = process.env.SPAWNFILE_MOLTNET_CLI;
    const previousReleaseDir = process.env.SPAWNFILE_MOLTNET_RELEASE_DIR;
    process.env.SPAWNFILE_MOLTNET_CLI = await createFakeMoltnetCli();
    process.env.SPAWNFILE_MOLTNET_RELEASE_DIR = await createFakeMoltnetReleaseDirectory();

    try {
      const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-mixed-runtime-out-"));
      temporaryDirectories.push(outputDirectory);

      const result = await compileProject(path.join(fixturesRoot, "e2e", "mixed-runtime-org"), {
        outputDirectory
      });
      const container = result.report.container;

      expect(container?.runtimes_installed).toEqual(["daimon", "openclaw", "picoclaw"]);
      expect(container?.runtime_instances.map((instance) => ({
        id: instance.id,
        methods: instance.model_auth_methods,
        nodes: instance.node_ids,
        runtime: instance.runtime
      })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
        {
          id: "agent-analyst",
          methods: { anthropic: "claude-code" },
          nodes: ["agent:analyst"],
          runtime: "picoclaw"
        },
        {
          id: "agent-conductor",
          methods: { anthropic: "claude-code" },
          nodes: ["agent:conductor"],
          runtime: "openclaw"
        },
        {
          id: "pi-app",
          methods: { local: "none" },
          nodes: ["agent:localist"],
          runtime: "daimon"
        }
      ]);
      expect(container?.moltnet?.node_plans.map((plan) => plan.network_id).sort()).toEqual([
        "mixed_lab",
        "mixed_lab",
        "mixed_lab"
      ]);

      const piConfig = JSON.parse(
        await readUtf8File(path.join(
          outputDirectory,
          "container/rootfs/var/lib/spawnfile/instances/daimon/pi-app/pi/pi-app.json"
        ))
      );
      const modelsConfig = JSON.parse(
        await readUtf8File(path.join(
          outputDirectory,
          "container/rootfs/var/lib/spawnfile/instances/daimon/pi-app/home/.pi/agent/models.json"
        ))
      );
      const provider = piConfig.agents[0]?.model.provider as string;
      expect(provider).toMatch(/^local-openai-llama3-2-[a-f0-9]{8}$/);
      expect(modelsConfig.providers[provider]).toMatchObject({
        api: "openai-completions",
        apiKey: "ollama",
        baseUrl: "http://host.docker.internal:11434/v1"
      });
    } finally {
      if (previousCli === undefined) delete process.env.SPAWNFILE_MOLTNET_CLI;
      else process.env.SPAWNFILE_MOLTNET_CLI = previousCli;
      if (previousReleaseDir === undefined) delete process.env.SPAWNFILE_MOLTNET_RELEASE_DIR;
      else process.env.SPAWNFILE_MOLTNET_RELEASE_DIR = previousReleaseDir;
    }
  }, 40_000);
});
