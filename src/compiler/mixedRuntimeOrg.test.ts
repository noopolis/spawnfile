import { chmod, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";

import { compileProject } from "./compileProject.js";

vi.mock("./moltnetBinaries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./moltnetBinaries.js")>();
  const { stageTrustedTestMoltnetRelease } = await import(
    "../../fixtures/support/trustedMoltnetRelease.js"
  );
  return {
    ...actual,
    stageMoltnetBinaries: async (outputDirectory: string, options: Parameters<
      typeof actual.stageMoltnetBinaries
    >[1]) => ({
      ...await stageTrustedTestMoltnetRelease(outputDirectory, options),
      capabilities: ["daimon-bridge", "pi-bridge"] as const
    })
  };
});

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "examples");

const createFakeMoltnetCli = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-mixed-moltnet-cli-"));
  temporaryDirectories.push(directory);
  const cliPath = path.join(directory, "moltnet.cjs");
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

describe("mixed runtime org fixture", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
  });

  it("compiles OpenClaw, PicoClaw, and Daimon agents into one container plan", async () => {
    const previousCli = process.env.SPAWNFILE_MOLTNET_CLI;
    const previousReleaseDir = process.env.SPAWNFILE_MOLTNET_RELEASE_DIR;
    process.env.SPAWNFILE_MOLTNET_CLI = await createFakeMoltnetCli();

    try {
      const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-mixed-runtime-out-"));
      temporaryDirectories.push(outputDirectory);

      const result = await compileProject(path.join(fixturesRoot, "mixed-runtime-org"), {
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
          id: "daimon-organization",
          methods: {},
          nodes: ["agent:localist"],
          runtime: "daimon"
        }
      ]);
      expect(container?.moltnet?.node_plans.map((plan) => plan.network_id).sort()).toEqual([
        "mixed_lab",
        "mixed_lab",
        "mixed_lab"
      ]);

      const daimonConfig = JSON.parse(await readUtf8File(path.join(
        outputDirectory,
        "container/rootfs/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json"
      )));
      expect(daimonConfig.agents[0]).toMatchObject({
        id: "agent:localist",
        engine: { kind: "codex" }
      });
      expect(process.env.SPAWNFILE_MOLTNET_RELEASE_DIR).toBe(previousReleaseDir);
    } finally {
      if (previousCli === undefined) delete process.env.SPAWNFILE_MOLTNET_CLI;
      else process.env.SPAWNFILE_MOLTNET_CLI = previousCli;
    }
  }, 40_000);
});
