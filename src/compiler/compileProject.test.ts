import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureDirectory,
  fileExists,
  readUtf8File,
  removeDirectory,
  writeUtf8File
} from "../filesystem/index.js";

import { compileProject } from "./compileProject.js";

const temporaryDirectories: string[] = [];
const fixturesRoot = path.resolve(process.cwd(), "fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("compileProject", () => {
  it("compiles a single agent and emits a report", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-compile-"));
    temporaryDirectories.push(outputDirectory);

    const result = await compileProject(path.join(fixturesRoot, "single-agent"), {
      outputDirectory
    });

    await expect(fileExists(result.reportPath)).resolves.toBe(true);
    await expect(
      fileExists(path.join(outputDirectory, "runtimes", "openclaw", "agents", "analyst", "openclaw.json"))
    ).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, "Dockerfile"))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, "entrypoint.sh"))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, ".env.example"))).resolves.toBe(true);
    await expect(fileExists(path.join(outputDirectory, "runtime-sources"))).resolves.toBe(false);
    await expect(
      fileExists(
        path.join(
          outputDirectory,
          "container",
          "rootfs",
          "var",
          "lib",
          "spawnfile",
          "instances",
          "openclaw",
          "agent-analyst",
          "home",
          ".openclaw",
          "openclaw.json"
        )
      )
    ).resolves.toBe(true);

    const agentNode = result.report.nodes.find((node) => node.kind === "agent");
    expect(agentNode?.runtime_ref).toBe("v2026.3.13-1");
    expect(agentNode?.runtime_status).toBe("active");
    expect(result.report.container).toEqual({
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      ports: [18789],
      runtimes_installed: ["openclaw"],
      secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "SEARCH_API_KEY"]
    });

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit openclaw@2026.3.13"
    );
    expect(dockerfile).toContain("COPY container/rootfs/ /");
    expect(dockerfile).not.toContain("COPY . /opt/spawnfile");
    expect(dockerfile).not.toContain("runtime-sources");

    const envExample = await readUtf8File(path.join(outputDirectory, ".env.example"));
    expect(envExample).toContain("ANTHROPIC_API_KEY=");
    expect(envExample).toContain("OPENCLAW_GATEWAY_TOKEN=");
    expect(envExample).toContain("SEARCH_API_KEY=");

    const entrypointStat = await stat(path.join(outputDirectory, "entrypoint.sh"));
    expect(entrypointStat.mode & 0o111).toBeGreaterThan(0);

    const entrypoint = await readUtf8File(path.join(outputDirectory, "entrypoint.sh"));
    expect(entrypoint).toContain(
      "'node' '/usr/local/lib/node_modules/openclaw/openclaw.mjs' 'gateway'"
    );
    expect(entrypoint).not.toContain("<runtime-root>");
    expect(entrypoint).not.toContain("prepare_target");

    const rootedConfig = await readUtf8File(
      path.join(
        outputDirectory,
        "container",
        "rootfs",
        "var",
        "lib",
        "spawnfile",
        "instances",
        "openclaw",
        "agent-analyst",
        "home",
        ".openclaw",
        "openclaw.json"
      )
    );
    expect(rootedConfig).not.toContain("<workspace-path>");
    expect(rootedConfig).toContain(
      "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/workspace"
    );
    expect(rootedConfig).toContain('"bind": "lan"');
    expect(rootedConfig).toContain('"allowedOrigins"');
    expect(rootedConfig).toContain('"http://127.0.0.1:18789"');
  }, 30000);

  it("marks a multi-runtime team as degraded at team level", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-"));
    temporaryDirectories.push(outputDirectory);

    const result = await compileProject(path.join(fixturesRoot, "multi-runtime-team"), {
      outputDirectory
    });

    const teamNode = result.report.nodes.find((node) => node.kind === "team");
    expect(teamNode?.capabilities.every((capability) => capability.outcome === "degraded")).toBe(
      true
    );

    const reportJson = await readUtf8File(result.reportPath);
    expect(reportJson).toContain("research-cell");
    expect(result.report.container).toEqual({
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      ports: [3777, 18789, 18790],
      runtimes_installed: ["openclaw", "picoclaw", "tinyclaw"],
      secrets_required: [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENCLAW_GATEWAY_TOKEN",
        "SEARCH_API_KEY"
      ]
    });

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit openclaw@2026.3.13"
    );
    expect(dockerfile).toContain(
      "https://github.com/sipeed/picoclaw/releases/download/v0.2.3/$asset"
    );
    expect(dockerfile).toContain(
      "https://github.com/TinyAGI/tinyagi/releases/download/v0.0.15/tinyagi-bundle.tar.gz"
    );
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("go build -o /usr/local/bin/picoclaw");
    expect(dockerfile).not.toContain("npm run build");

    await expect(fileExists(path.join(outputDirectory, "runtime-sources"))).resolves.toBe(false);

    const entrypoint = await readUtf8File(path.join(outputDirectory, "entrypoint.sh"));
    expect(entrypoint).toContain("OPENCLAW_HOME=");
    expect(entrypoint).toContain("PICOCLAW_HOME=");
    expect(entrypoint).toContain("TINYAGI_HOME=");
    expect(entrypoint).toContain("/opt/spawnfile/runtime-installs/tinyclaw/packages/main/dist/index.js");
    expect(entrypoint).not.toContain("prepare_target");
  }, 30000);

  it("marks a single-runtime team as degraded when the runtime has no native team compiler", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-single-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "a"));
    await ensureDirectory(path.join(directory, "agents", "b"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "a", "AGENTS.md"), "# A\n");
    await writeUtf8File(path.join(directory, "agents", "b", "AGENTS.md"), "# B\n");
    await writeUtf8File(
      path.join(directory, "agents", "a", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: openclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "b", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: b", "", "runtime: openclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: a",
        "    ref: ./agents/a",
        "  - id: b",
        "    ref: ./agents/b",
        "",
        "structure:",
        "  mode: hierarchical",
        "  leader: a",
        ""
      ].join("\n")
    );

    const result = await compileProject(directory, { outputDirectory: path.join(directory, "out") });
    const teamNode = result.report.nodes.find((node) => node.kind === "team");

    expect(teamNode?.runtime).toBe("openclaw");
    expect(teamNode?.output_dir).toBeNull();
  }, 30000);

  it("fails when runtime options are invalid", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-bad-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Instructions\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: invalid",
        "",
        "runtime:",
        "  name: picoclaw",
        "  options:",
        '    restrict_to_workspace: "yes"',
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(
      compileProject(directory, { outputDirectory: path.join(directory, "dist") })
    ).rejects.toThrow(/restrict_to_workspace/);
  });

  it("fails when policy sets on_degrade to error for degraded capabilities", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-policy-degraded-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "subagents", "critic"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Main agent\n");
    await writeUtf8File(path.join(directory, "subagents", "critic", "AGENTS.md"), "# Critic\n");
    await writeUtf8File(
      path.join(directory, "subagents", "critic", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: critic",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: lead",
        "",
        "runtime: openclaw",
        "",
        "docs:",
        "  system: AGENTS.md",
        "",
        "subagents:",
        "  - id: critic",
        "    ref: ./subagents/critic",
        "",
        "policy:",
        "  mode: warn",
        "  on_degrade: error",
        ""
      ].join("\n")
    );

    await expect(
      compileProject(directory, { outputDirectory: path.join(directory, "dist") })
    ).rejects.toThrow(/on_degrade: error/);
  });

  it("emits a native team artifact when the runtime adapter supports teams", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-native-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "a"));
    await ensureDirectory(path.join(directory, "agents", "b"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "a", "AGENTS.md"), "# A\n");
    await writeUtf8File(path.join(directory, "agents", "b", "AGENTS.md"), "# B\n");
    await writeUtf8File(
      path.join(directory, "agents", "a", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: tinyclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "b", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: b", "", "runtime: tinyclaw", "", "docs:", "  system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: team",
        "",
        "docs:",
        "  system: TEAM.md",
        "",
        "members:",
        "  - id: a",
        "    ref: ./agents/a",
        "  - id: b",
        "    ref: ./agents/b",
        "",
        "structure:",
        "  mode: hierarchical",
        "  leader: a",
        ""
      ].join("\n")
    );

    const outputDirectory = path.join(directory, "out");
    const result = await compileProject(directory, { outputDirectory });
    const teamNode = result.report.nodes.find((node) => node.kind === "team");

    expect(teamNode?.output_dir).toBe("runtimes/tinyclaw/teams/team");
    await expect(
      fileExists(path.join(outputDirectory, "runtimes", "tinyclaw", "teams", "team", "tinyclaw-team.json"))
    ).resolves.toBe(true);
    await expect(
      fileExists(
        path.join(
          outputDirectory,
          "container",
          "rootfs",
          "var",
          "lib",
          "spawnfile",
          "instances",
          "tinyclaw",
          "tinyclaw-runtime",
          "tinyagi",
          "settings.json"
        )
      )
    ).resolves.toBe(true);

    const mergedSettings = JSON.parse(
      await readUtf8File(
        path.join(
          outputDirectory,
          "container",
          "rootfs",
          "var",
          "lib",
          "spawnfile",
          "instances",
          "tinyclaw",
          "tinyclaw-runtime",
          "tinyagi",
          "settings.json"
        )
      )
    );
    expect(Object.keys(mergedSettings.agents)).toEqual(["a", "b"]);
    expect(mergedSettings.teams.team.leader_agent).toBe("a");
  }, 30000);

  it("preserves existing output files when clean is disabled", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-no-clean-"));
    temporaryDirectories.push(outputDirectory);

    const sentinelPath = path.join(outputDirectory, "sentinel.txt");
    await writeUtf8File(sentinelPath, "keep\n");

    await compileProject(path.join(fixturesRoot, "single-agent"), {
      clean: false,
      outputDirectory
    });

    await expect(readUtf8File(sentinelPath)).resolves.toBe("keep\n");
  }, 30000);
});
