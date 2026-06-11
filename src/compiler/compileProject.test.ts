import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { chmod, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

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
const execFile = promisify(execFileCallback);

const createFakeMoltnetCli = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-cli-"));
  temporaryDirectories.push(directory);

  const cliPath = path.join(directory, "moltnet");
  await writeUtf8File(
    cliPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'version') {",
      "  process.stdout.write('0.0.0-test\\n');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'skill' && args[1] === 'install') {",
      "  const flags = new Map();",
      "  for (let index = 2; index < args.length; index += 2) {",
      "    flags.set(args[index], args[index + 1]);",
      "  }",
      "  const runtime = flags.get('--runtime');",
      "  const workspace = flags.get('--workspace');",
      "  const content = '# name: moltnet\\nMoltnet is a transport, not an implicit reply channel.\\n';",
      "  const targets = [path.join(workspace, 'skills', 'moltnet', 'SKILL.md')];",
      "  for (const target of targets) {",
      "    fs.mkdirSync(path.dirname(target), { recursive: true });",
      "    fs.writeFileSync(target, content);",
      "  }",
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-release-"));
  temporaryDirectories.push(directory);

  const payloadDirectory = path.join(directory, "payload");
  await ensureDirectory(payloadDirectory);
  const binaryPath = path.join(payloadDirectory, "moltnet");
  await writeUtf8File(binaryPath, "#!/usr/bin/env sh\necho moltnet\n");
  await chmod(binaryPath, 0o755);

  const assetName = `moltnet_linux_${process.arch === "arm64" ? "arm64" : "amd64"}.tar.gz`;
  await execFile("tar", ["-C", payloadDirectory, "-czf", path.join(directory, assetName), "."]);

  return directory;
};

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
    expect(agentNode?.runtime_ref).toBe("v2026.6.5");
    expect(agentNode?.runtime_status).toBe("active");
    expect(result.report.container).toEqual({
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      internal_ports: [18789],
      model_secrets_required: ["ANTHROPIC_API_KEY"],
      port_mappings: [],
      ports: [],
      published_ports: [],
      runtime_instances: [
        {
          config_path: "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/openclaw.json",
          home_path: "/var/lib/spawnfile/instances/openclaw/agent-analyst/home",
          id: "agent-analyst",
          internal_port: 18789,
          model_auth_methods: {
            anthropic: "api_key"
          },
          model_secrets_required: ["ANTHROPIC_API_KEY"],
          node_ids: ["agent:analyst"],
          published_port: null,
          runtime: "openclaw",
          workspace_path: "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/workspace"
        }
      ],
      runtime_homes: ["/var/lib/spawnfile/instances/openclaw/agent-analyst/home"],
      runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
      runtimes_installed: ["openclaw"],
      secrets_required: ["ANTHROPIC_API_KEY", "OPENCLAW_GATEWAY_TOKEN", "SEARCH_API_KEY"]
    });

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit openclaw@2026.6.5"
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
    expect(rootedConfig).toContain('"bind": "loopback"');
    expect(rootedConfig).toContain('"allowedOrigins"');
    expect(rootedConfig).toContain('"http://127.0.0.1:18789"');
  }, 30000);

  it("marks a multi-runtime team as degraded at team level", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-src-"));
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-"));
    temporaryDirectories.push(directory);
    temporaryDirectories.push(outputDirectory);

    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    for (const [id, runtime] of [
      ["orchestrator", "openclaw"],
      ["researcher", "picoclaw"],
      ["writer", "picoclaw"]
    ] as const) {
      await ensureDirectory(path.join(directory, "agents", id));
      await writeUtf8File(
        path.join(directory, "agents", id, "Spawnfile"),
        [
          'spawnfile_version: "0.1"',
          "kind: agent",
          `name: ${id}`,
          "",
          `runtime: ${runtime}`,
          "",
          "execution:",
          "  model:",
          "    primary:",
          "      provider: anthropic",
          "      name: claude-sonnet-4-5",
          "      auth:",
          "        method: claude-code",
          ""
        ].join("\n")
      );
    }
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: research-cell",
        "",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
        "",
        "members:",
        "  - id: orchestrator",
        "    ref: ./agents/orchestrator",
        "  - id: researcher",
        "    ref: ./agents/researcher",
        "  - id: writer",
        "    ref: ./agents/writer",
        "",
        "mode: hierarchical",
        "lead: orchestrator",
        ""
      ].join("\n")
    );

    const result = await compileProject(directory, { outputDirectory });

    const teamNode = result.report.nodes.find((node) => node.kind === "team");
    expect(teamNode?.capabilities.some((capability) => capability.outcome === "degraded")).toBe(
      true
    );
    expect(teamNode?.diagnostics).toContainEqual({
      level: "warn",
      message:
        "Policy warning: team.members is degraded for team:research-cell: Team spans multiple runtimes and cannot lower to one native team artifact in v0.1"
    });

    const reportJson = await readUtf8File(result.reportPath);
    expect(reportJson).toContain("research-cell");
    expect(result.report.container).toEqual({
      dockerfile: "Dockerfile",
      entrypoint: "entrypoint.sh",
      env_example: ".env.example",
      internal_ports: [18789, 18990, 18991],
      model_secrets_required: [],
      port_mappings: [],
      ports: [],
      published_ports: [],
      runtime_instances: [
        {
          config_path: "/var/lib/spawnfile/instances/openclaw/agent-orchestrator/home/.openclaw/openclaw.json",
          home_path: "/var/lib/spawnfile/instances/openclaw/agent-orchestrator/home",
          id: "agent-orchestrator",
          internal_port: 18789,
          model_auth_methods: {
            anthropic: "claude-code"
          },
          model_secrets_required: [],
          node_ids: ["agent:orchestrator"],
          published_port: null,
          runtime: "openclaw",
          workspace_path: "/var/lib/spawnfile/instances/openclaw/agent-orchestrator/home/.openclaw/workspace"
        },
        {
          config_path: "/var/lib/spawnfile/instances/picoclaw/agent-researcher/picoclaw/config.json",
          home_path: "/var/lib/spawnfile/instances/picoclaw/agent-researcher/picoclaw",
          id: "agent-researcher",
          internal_port: 18990,
          model_auth_methods: {
            anthropic: "claude-code"
          },
          model_secrets_required: [],
          node_ids: ["agent:researcher"],
          published_port: null,
          runtime: "picoclaw",
          workspace_path: "/var/lib/spawnfile/instances/picoclaw/agent-researcher/picoclaw/workspace"
        },
        {
          config_path: "/var/lib/spawnfile/instances/picoclaw/agent-writer/picoclaw/config.json",
          home_path: "/var/lib/spawnfile/instances/picoclaw/agent-writer/picoclaw",
          id: "agent-writer",
          internal_port: 18991,
          model_auth_methods: {
            anthropic: "claude-code"
          },
          model_secrets_required: [],
          node_ids: ["agent:writer"],
          published_port: null,
          runtime: "picoclaw",
          workspace_path: "/var/lib/spawnfile/instances/picoclaw/agent-writer/picoclaw/workspace"
        }
      ],
      runtime_homes: [
        "/var/lib/spawnfile/instances/openclaw/agent-orchestrator/home",
        "/var/lib/spawnfile/instances/picoclaw/agent-researcher/picoclaw",
        "/var/lib/spawnfile/instances/picoclaw/agent-writer/picoclaw"
      ],
      runtime_secrets_required: ["OPENCLAW_GATEWAY_TOKEN"],
      runtimes_installed: ["openclaw", "picoclaw"],
      secrets_required: ["OPENCLAW_GATEWAY_TOKEN"]
    });

    const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("USER root");
    expect(dockerfile).toContain(
      "RUN npm install -g --omit=dev --no-fund --no-audit openclaw@2026.6.5"
    );
    expect(dockerfile).toContain(
      "https://github.com/sipeed/picoclaw/releases/download/v0.2.9/$asset"
    );
    expect(dockerfile).not.toContain("runtime-sources");
    expect(dockerfile).not.toContain("go build -o /usr/local/bin/picoclaw");
    expect(dockerfile).not.toContain("npm run build");

    await expect(fileExists(path.join(outputDirectory, "runtime-sources"))).resolves.toBe(false);

    const entrypoint = await readUtf8File(path.join(outputDirectory, "entrypoint.sh"));
    expect(entrypoint).toContain("OPENCLAW_HOME=");
    expect(entrypoint).toContain("PICOCLAW_HOME=");
    expect(entrypoint).not.toContain("prepare_target");
  }, 30000);

  it("reports workspace resources and startup preparation for compiled agents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-resource-compile-src-"));
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-resource-compile-"));
    temporaryDirectories.push(directory);
    temporaryDirectories.push(outputDirectory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "  resources:",
        "    - id: project",
        "      kind: git",
        "      url: https://example.com/project.git",
        "      ref: abc123",
        "      mount: ./repos/project",
        "      mode: mutable",
        "    - id: cache",
        "      kind: volume",
        "      mount: ./cache",
        "      mode: readonly",
        ""
      ].join("\n")
    );

    const result = await compileProject(directory, { outputDirectory });
    const agentReport = result.report.nodes.find((node) => node.kind === "agent");
    const entrypoint = await readUtf8File(path.join(outputDirectory, "entrypoint.sh"));

    expect(agentReport?.capabilities).toContainEqual({
      key: "workspace.resources",
      message: "2 workspace resource(s) will be prepared at startup",
      outcome: "supported"
    });
    expect(result.report.container?.workspace_resources).toEqual([
      {
        backing_path: expect.stringContaining("/var/lib/spawnfile/resources/instances/agent-worker-"),
        id: "cache",
        kind: "volume",
        link_path: "/var/lib/spawnfile/instances/openclaw/agent-worker/home/.openclaw/workspace/cache",
        mode: "readonly",
        mount: "./cache",
        sharing: "per_agent"
      },
      {
        backing_path: expect.stringContaining("/var/lib/spawnfile/resources/instances/agent-worker-"),
        id: "project",
        kind: "git",
        link_path: "/var/lib/spawnfile/instances/openclaw/agent-worker/home/.openclaw/workspace/repos/project",
        mode: "mutable",
        mount: "./repos/project",
        sharing: "per_agent"
      }
    ]);
    expect(entrypoint).toContain(
      "prepare_git_resource 'project' '/var/lib/spawnfile/instances/openclaw/agent-worker/home/.openclaw/workspace/repos/project' '/var/lib/spawnfile/resources/instances/agent-worker-"
    );
    expect(entrypoint).toContain(
      "prepare_volume_resource 'cache' '/var/lib/spawnfile/instances/openclaw/agent-worker/home/.openclaw/workspace/cache' '/var/lib/spawnfile/resources/instances/agent-worker-"
    );
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
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: openclaw", "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "b", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: b", "", "runtime: openclaw", "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: team",
        "",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
        "",
        "members:",
        "  - id: a",
        "    ref: ./agents/a",
        "  - id: b",
        "    ref: ./agents/b",
        "",
        "mode: hierarchical",
        "lead: a",
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
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(
      compileProject(directory, { outputDirectory: path.join(directory, "dist") })
    ).rejects.toThrow(/restrict_to_workspace/);
  });

  it(
    "emits moltnet node configs and staged local container wiring for team networks",
    async () => {
      const previousCli = process.env.SPAWNFILE_MOLTNET_CLI;
      const previousReleaseDir = process.env.SPAWNFILE_MOLTNET_RELEASE_DIR;
      process.env.SPAWNFILE_MOLTNET_CLI = await createFakeMoltnetCli();
      process.env.SPAWNFILE_MOLTNET_RELEASE_DIR = await createFakeMoltnetReleaseDirectory();

      try {
        const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-compile-"));
        temporaryDirectories.push(directory);

        await ensureDirectory(path.join(directory, "agents", "orchestrator"));
        await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
        await writeUtf8File(
          path.join(directory, "agents", "orchestrator", "AGENTS.md"),
          "# Agent\n"
        );
        await writeUtf8File(
          path.join(directory, "agents", "orchestrator", "Spawnfile"),
          [
            'spawnfile_version: "0.1"',
            "kind: agent",
            "name: orchestrator-agent",
            "",
            "runtime: openclaw",
            "",
            "workspace:",
            "  docs:",
            "    system: AGENTS.md",
            "",
            "surfaces:",
            "  moltnet:",
            "    - network: local_lab",
            "      rooms:",
            "        research:",
            "          wake: all",
            ""
          ].join("\n")
        );
        await writeUtf8File(
          path.join(directory, "Spawnfile"),
          [
            'spawnfile_version: "0.1"',
            "kind: team",
            "name: research-cell",
            "",
            "shared:",
            "  workspace:",
            "    docs:",
            "      system: TEAM.md",
            "",
            "members:",
            "  - id: orchestrator",
            "    ref: ./agents/orchestrator",
            "",
            "mode: hierarchical",
            "lead: orchestrator",
            "",
            "networks:",
            "  - id: local_lab",
            "    provider: moltnet",
            "    server:",
            "      mode: managed",
            "      listen:",
            "        bind: 127.0.0.1",
            "        port: 8787",
            "      store:",
            "        kind: memory",
            "      auth:",
            "        mode: bearer",
            "        public_read: true",
            "        agent_registration: open",
            "        tokens:",
            "          - id: operator",
            "            secret: MOLTNET_OPERATOR_TOKEN",
            "            scopes: [admin, write]",
            "      human_ingress: true",
            "    rooms:",
            "      - id: research",
            "        members: [orchestrator]",
            ""
          ].join("\n")
        );

        const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-out-"));
        temporaryDirectories.push(outputDirectory);

        const result = await compileProject(directory, { outputDirectory });
        const dockerfile = await readUtf8File(path.join(outputDirectory, "Dockerfile"));
        const entrypoint = await readUtf8File(path.join(outputDirectory, "entrypoint.sh"));
        const nodeConfig = await readUtf8File(
          path.join(
            outputDirectory,
            "container",
            "rootfs",
            "var",
            "lib",
            "spawnfile",
            "moltnet",
            "nodes",
            "research-cell-local_lab-orchestrator.json"
          )
        );

        expect(result.report.container?.ports).toEqual([8787]);
        expect(dockerfile).not.toContain("FROM golang:1.24-bookworm AS moltnet-builder");
        expect(dockerfile).toContain("COPY moltnet-bin/ /usr/local/bin/");
        expect(dockerfile).toContain("RUN chmod +x /usr/local/bin/moltnet");
        expect(dockerfile).not.toContain("https://moltnet.dev/install.sh");
        expect(dockerfile).not.toContain("surface-router.js");
        expect(dockerfile).not.toContain("router-config.json");
        expect(entrypoint).toContain("/usr/local/bin/moltnet");
        expect(entrypoint).toContain("/usr/local/bin/moltnet node");
        expect(entrypoint).toContain("http://127.0.0.1:8787/healthz");
        expect(entrypoint).not.toContain("surface-router.js");
        expect(nodeConfig).toContain('"version": "moltnet.node.v1"');
        expect(nodeConfig).toContain('"gateway_url": "ws://127.0.0.1:18789"');
        expect(nodeConfig).toContain('"auth_mode": "open"');
        expect(nodeConfig).toContain('"registration": "open"');
        expect(nodeConfig).toContain(
          '"token_path": "/var/lib/spawnfile/agents/orchestrator-agent/state/moltnet/local_lab-orchestrator.token"'
        );
        expect(nodeConfig).toContain(
          '"home_path": "/var/lib/spawnfile/instances/openclaw/agent-orchestrator-agent/home"'
        );
        expect(
          await readUtf8File(path.join(outputDirectory, "moltnet-bin", "moltnet"))
        ).toContain("echo moltnet");
        await expect(fileExists(path.join(outputDirectory, "moltnet-bin", "moltnet"))).resolves.toBe(
          true
        );
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              ".spawnfile",
              "roster.yaml"
            )
          )
        ).resolves.toBe(true);
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              "TEAM.md"
            )
          )
        ).resolves.toBe(true);
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              ".spawnfile",
              "team-contexts",
              "research-cell",
              "TEAM.md"
            )
          )
        ).resolves.toBe(true);
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              ".spawnfile",
              "rosters",
              "research-cell.yaml"
            )
          )
        ).resolves.toBe(true);
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              ".spawnfile",
              "team-contexts.yaml"
            )
          )
        ).resolves.toBe(true);
        await expect(fileExists(path.join(outputDirectory, "surface-router.js"))).resolves.toBe(
          false
        );
        await expect(fileExists(path.join(outputDirectory, "router-config.json"))).resolves.toBe(
          false
        );
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "container",
              "rootfs",
              "usr",
              "local",
              "bin",
              "spawnfile-team-message"
            )
          )
        ).resolves.toBe(false);
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              ".spawnfile",
              "team-mcp.js"
            )
          )
        ).resolves.toBe(false);
        await expect(
          fileExists(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              ".spawnfile",
              "team.json"
            )
          )
        ).resolves.toBe(false);
        const agentsMd = await readUtf8File(
          path.join(
            outputDirectory,
            "runtimes",
            "openclaw",
            "agents",
            "orchestrator-agent",
            "workspace",
            "AGENTS.md"
          )
        );
        expect(agentsMd).toContain("## Spawnfile Team Context");
        expect(agentsMd).toContain(".spawnfile/team-contexts.md");
        expect(agentsMd).not.toContain("team_message");
        expect(agentsMd).not.toContain("spawnfile-team-message");
        expect(
          await readUtf8File(
            path.join(
              outputDirectory,
              "runtimes",
              "openclaw",
              "agents",
              "orchestrator-agent",
              "workspace",
              "skills",
              "moltnet",
              "SKILL.md"
            )
          )
        ).toContain("Moltnet is a transport, not an implicit reply channel.");
        const clientConfig = await readUtf8File(
          path.join(
            outputDirectory,
            "runtimes",
            "openclaw",
            "agents",
            "orchestrator-agent",
            "workspace",
            ".moltnet",
            "config.json"
          )
        );
        expect(clientConfig).toContain('"base_url": "http://127.0.0.1:8787"');
        expect(clientConfig).toContain('"mode": "open"');
        expect(clientConfig).toContain(
          '"token_path": "/var/lib/spawnfile/agents/orchestrator-agent/state/moltnet/local_lab-orchestrator.token"'
        );
      } finally {
        if (previousCli === undefined) {
          delete process.env.SPAWNFILE_MOLTNET_CLI;
        } else {
          process.env.SPAWNFILE_MOLTNET_CLI = previousCli;
        }
        if (previousReleaseDir === undefined) {
          delete process.env.SPAWNFILE_MOLTNET_RELEASE_DIR;
        } else {
          process.env.SPAWNFILE_MOLTNET_RELEASE_DIR = previousReleaseDir;
        }
      }
    },
    40_000
  );

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
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
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
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
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
