import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";

const fixturesRoot = path.resolve(process.cwd(), "fixtures");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("buildCompilePlan", () => {
  it("builds a single-agent plan", async () => {
    const plan = await buildCompilePlan(path.join(fixturesRoot, "single-agent"));

    expect(plan.nodes).toHaveLength(1);
    expect(plan.runtimes.openclaw.nodeIds).toHaveLength(1);
  });

  it("applies default workspace and sandbox execution intent when omitted", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-default-execution-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(path.join(directory, "IDENTITY.md"), "# Identity\n");
    await writeUtf8File(path.join(directory, "SOUL.md"), "# Soul\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: openai",
        "      name: gpt-5.4",
        "",
        "workspace:",
        "  docs:",
        "    identity: IDENTITY.md",
        "    soul: SOUL.md",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agentNode = plan.nodes.find((node) => node.kind === "agent");

    expect(agentNode?.kind).toBe("agent");
    if (!agentNode || agentNode.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agentNode.value.execution?.sandbox).toEqual({ mode: "workspace" });
    expect(agentNode.value.policyMode).toBe("warn");
    expect(agentNode.value.policyOnDegrade).toBe("warn");
  });

  it("derives missing agent descriptions from identity docs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-description-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "IDENTITY.md"), [
      "# Identity",
      "",
      "  First paragraph describes the agent.",
      "It can span lines and should normalize whitespace.",
      "",
      "Second paragraph is ignored.",
      ""
    ].join("\n"));
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    identity: IDENTITY.md",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agentNode = plan.nodes.find((node) => node.kind === "agent");
    if (!agentNode || agentNode.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agentNode.value.description).toBe(
      "First paragraph describes the agent. It can span lines and should normalize whitespace."
    );
  });

  it("builds a subagent graph", async () => {
    const plan = await buildCompilePlan(path.join(fixturesRoot, "agent-with-subagents"));

    expect(plan.nodes.filter((node) => node.kind === "agent")).toHaveLength(3);
    expect(plan.edges.filter((edge) => edge.kind === "subagent")).toHaveLength(2);
  });

  it("inherits team workspace resources into concrete agents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-resources-"));
    temporaryDirectories.push(directory);
    await ensureDirectory(path.join(directory, "agents", "worker"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "worker", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: lab",
        "mode: hierarchical",
        "lead: worker",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "  resources:",
        "    - id: project",
        "      kind: git",
        "      url: https://example.com/project.git",
        "      branch: main",
        "      mount: /work/project",
        "      mode: mutable",
        "members:",
        "  - id: worker",
        "    ref: ./agents/worker",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "worker", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "  resources:",
        "    - id: cache",
        "      kind: volume",
        "      mount: /cache",
        "      mode: mutable",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const team = plan.nodes.find((node) => node.kind === "team");
    const agent = plan.nodes.find((node) => node.kind === "agent");

    expect(team?.value.workspaceResources).toEqual([
      {
        branch: "main",
        id: "project",
        kind: "git",
        mode: "mutable",
        mount: "/work/project",
        url: "https://example.com/project.git"
      }
    ]);
    expect(agent?.value.workspaceResources).toEqual([
      {
        id: "cache",
        kind: "volume",
        mode: "mutable",
        mount: "/cache"
      },
      {
        branch: "main",
        id: "project",
        kind: "git",
        mode: "mutable",
        mount: "/work/project",
        url: "https://example.com/project.git"
      }
    ]);
  });

  it("rejects inherited workspace resources with overlapping agent mounts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-resource-conflict-"));
    temporaryDirectories.push(directory);
    await ensureDirectory(path.join(directory, "agents", "worker"));
    await writeUtf8File(path.join(directory, "agents", "worker", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: lab",
        "mode: hierarchical",
        "lead: worker",
        "workspace:",
        "  resources:",
        "    - id: project",
        "      kind: volume",
        "      mount: /work/project",
        "      mode: mutable",
        "members:",
        "  - id: worker",
        "    ref: ./agents/worker",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "worker", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "  resources:",
        "    - id: docs",
        "      kind: volume",
        "      mount: /work/project/docs",
        "      mode: readonly",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /Workspace resources project and docs use overlapping mounts/
    );
  });

  it("resolves Discord surfaces with the default bot token secret", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-discord-surface-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: anthropic",
        "      name: claude-opus-4-6",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "",
        "surfaces:",
        "  discord: {}",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agentNode = plan.nodes.find((node) => node.kind === "agent");

    expect(agentNode?.value.kind).toBe("agent");
    if (!agentNode || agentNode.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agentNode.value.surfaces?.discord).toEqual({
      botTokenSecret: "DISCORD_BOT_TOKEN"
    });
  });

  it("resolves Discord allowlist access on agents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-discord-access-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "surfaces:",
        "  discord:",
        "    access:",
        "      users:",
        '        - "987654321098765432"',
        '      guilds:',
        '        - "123456789012345678"',
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agentNode = plan.nodes.find((node) => node.kind === "agent");

    expect(agentNode?.value.kind).toBe("agent");
    if (!agentNode || agentNode.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agentNode.value.surfaces?.discord).toEqual({
      access: {
        channels: [],
        guilds: ["123456789012345678"],
        mode: "allowlist",
        users: ["987654321098765432"]
      },
      botTokenSecret: "DISCORD_BOT_TOKEN"
    });
  });

  it("resolves Telegram surfaces with the default bot token secret", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-telegram-surface-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "",
        "surfaces:",
        "  telegram: {}",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agentNode = plan.nodes.find((node) => node.kind === "agent");

    expect(agentNode?.value.kind).toBe("agent");
    if (!agentNode || agentNode.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agentNode.value.surfaces?.telegram).toEqual({
      botTokenSecret: "TELEGRAM_BOT_TOKEN"
    });
  });

  it("resolves Telegram allowlist access on agents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-telegram-access-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "surfaces:",
        "  telegram:",
        "    access:",
        "      users:",
        '        - "123456789"',
        "      chats:",
        '        - "-1001234567890"',
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agentNode = plan.nodes.find((node) => node.kind === "agent");

    expect(agentNode?.value.kind).toBe("agent");
    if (!agentNode || agentNode.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agentNode.value.surfaces?.telegram).toEqual({
      access: {
        chats: ["-1001234567890"],
        mode: "allowlist",
        users: ["123456789"]
      },
      botTokenSecret: "TELEGRAM_BOT_TOKEN"
    });
  });

  it("builds a multi-runtime team graph", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-multi-runtime-plan-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    for (const [id, runtime] of [
      ["orchestrator", "openclaw"],
      ["researcher", "picoclaw"],
      ["writer", "tinyclaw"]
    ] as const) {
      await ensureDirectory(path.join(directory, "agents", id));
      await writeUtf8File(path.join(directory, "agents", id, "AGENTS.md"), `# ${id}\n`);
      await writeUtf8File(
        path.join(directory, "agents", id, "Spawnfile"),
        ['spawnfile_version: "0.1"', "kind: agent", `name: ${id}`, "", `runtime: ${runtime}`, "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
      );
    }
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: research-cell",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
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

    const plan = await buildCompilePlan(directory);

    expect(Object.keys(plan.runtimes).sort()).toEqual(["openclaw", "picoclaw", "tinyclaw"]);
    expect(plan.nodes.find((node) => node.kind === "team")).toBeTruthy();
  });

  it("resolves team networks and team-scoped moltnet attachments", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-plan-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "researcher"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "agents", "researcher", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: researcher-agent",
        "",
        "runtime: openclaw",
        "",
        "surfaces:",
        "  moltnet:",
        "    - network: local_lab",
        "      rooms:",
        "        research:",
        "          read: mentions",
        "          reply: auto",
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
        "kind: team",
        "name: research-cell",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: researcher",
        "    ref: ./agents/researcher",
        "",
        "mode: hierarchical",
        "lead: researcher",
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
        "        mode: none",
        "    rooms:",
        "      - id: research",
        "        members: [researcher]",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const teamNode = plan.nodes.find((node) => node.kind === "team");
    const agentNode = plan.nodes.find((node) => node.kind === "agent");

    expect(teamNode?.value.kind).toBe("team");
    expect(agentNode?.value.kind).toBe("agent");
    if (!teamNode || teamNode.value.kind !== "team" || !agentNode || agentNode.value.kind !== "agent") {
      throw new Error("expected team and agent nodes");
    }

    expect(teamNode.value.policyMode).toBe("warn");
    expect(teamNode.value.policyOnDegrade).toBe("warn");
    expect(agentNode.value.policyMode).toBe("warn");
    expect(agentNode.value.policyOnDegrade).toBe("warn");
    expect(teamNode.value.networks).toEqual([
      {
        id: "local_lab",
        name: "local_lab",
        provider: "moltnet",
        rooms: [
          {
            id: "research",
            members: ["researcher"]
          }
        ],
        server: {
          auth: { mode: "none" },
          listen: { bind: "127.0.0.1", port: 8787 },
          mode: "managed",
          store: { kind: "memory" }
        }
      }
    ]);
    expect(agentNode.value.surfaces?.moltnet).toEqual([
      {
        contextRooms: {
          [teamNode.value.source]: ["research"]
        },
        memberId: "researcher",
        network: "local_lab",
        rooms: {
          research: {
            read: "mentions",
            reply: "auto"
          }
        },
        teamSource: teamNode.value.source
      }
    ]);
  });

  it("rejects moltnet attachments on standalone agents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-standalone-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: researcher",
        "",
        "runtime: openclaw",
        "",
        "surfaces:",
        "  moltnet:",
        "    - network: local_lab",
        "      dms:",
        "        enabled: true",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/not attached to a team network/);
  });

  it("rejects moltnet attachments that reference unknown rooms", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-bad-room-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "researcher"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "agents", "researcher", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: researcher-agent",
        "",
        "runtime: openclaw",
        "",
        "surfaces:",
        "  moltnet:",
        "    - network: local_lab",
        "      rooms:",
        "        missing:",
        "          read: mentions",
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
        "kind: team",
        "name: research-cell",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: researcher",
        "    ref: ./agents/researcher",
        "",
        "mode: hierarchical",
        "lead: researcher",
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
        "        mode: none",
        "    rooms:",
        "      - id: research",
        "        members: [researcher]",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/unknown Moltnet room missing/);
  });

  it("rejects duplicate moltnet member ids across direct agent slots", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-member-collision-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    for (const teamName of ["one", "two"]) {
      await ensureDirectory(path.join(directory, "teams", teamName, "agents", "rep"));
      await writeUtf8File(path.join(directory, "teams", teamName, "TEAM.md"), `# ${teamName}\n`);
      await writeUtf8File(path.join(directory, "teams", teamName, "agents", "rep", "AGENTS.md"), "# Rep\n");
      await writeUtf8File(
        path.join(directory, "teams", teamName, "agents", "rep", "Spawnfile"),
        ['spawnfile_version: "0.1"', "kind: agent", `name: ${teamName}-rep`, "", "runtime: openclaw", "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
      );
      await writeUtf8File(
        path.join(directory, "teams", teamName, "Spawnfile"),
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          `name: ${teamName}`,
          "",
          "workspace:",
          "  docs:",
          "    system: TEAM.md",
          "",
          "members:",
          "  - id: rep",
          "    ref: ./agents/rep",
          "",
          "mode: swarm",
          ""
        ].join("\n")
      );
    }
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: collision",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: one",
        "    ref: ./teams/one",
        "  - id: two",
        "    ref: ./teams/two",
        "",
        "mode: swarm",
        "",
        "networks:",
        "  - id: org",
        "    provider: moltnet",
        "    server:",
        "      mode: managed",
        "      listen:",
        "        bind: 127.0.0.1",
        "        port: 8787",
        "      store:",
        "        kind: memory",
        "      auth:",
        "        mode: none",
        "    rooms:",
        "      - id: room",
        "        members: [one, two]",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/Moltnet member_id rep/);
  });

  it("preserves authored team network slots for nested representatives", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-nested-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "researcher"));
    await ensureDirectory(path.join(directory, "teams", "subteam"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(path.join(directory, "teams", "subteam", "TEAM.md"), "# Subteam\n");
    await writeUtf8File(
      path.join(directory, "agents", "researcher", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: researcher-agent",
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
      path.join(directory, "teams", "subteam", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: subteam",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: placeholder",
        "    ref: ./placeholder",
        "",
        "mode: swarm",
        ""
      ].join("\n")
    );
    await ensureDirectory(path.join(directory, "teams", "subteam", "placeholder"));
    await writeUtf8File(
      path.join(directory, "teams", "subteam", "placeholder", "AGENTS.md"),
      "# Placeholder\n"
    );
    await writeUtf8File(
      path.join(directory, "teams", "subteam", "placeholder", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: placeholder-agent",
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
        "kind: team",
        "name: research-cell",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: researcher",
        "    ref: ./agents/researcher",
        "  - id: subteam",
        "    ref: ./teams/subteam",
        "",
        "mode: hierarchical",
        "lead: researcher",
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
        "        mode: none",
        "    rooms:",
        "      - id: research",
        "        members: [researcher, subteam]",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const parentTeam = plan.nodes.find(
      (node) => node.kind === "team" && node.value.name === "research-cell"
    );
    const representativeAgent = plan.nodes.find(
      (node) => node.kind === "agent" && node.value.name === "placeholder-agent"
    );

    expect(parentTeam?.value.kind).toBe("team");
    expect(representativeAgent?.value.kind).toBe("agent");
    if (
      !parentTeam ||
      parentTeam.value.kind !== "team" ||
      !representativeAgent ||
      representativeAgent.value.kind !== "agent"
    ) {
      throw new Error("expected parent team and representative agent");
    }

    expect(parentTeam.value.networks?.[0]?.rooms[0]?.members).toEqual([
      "researcher",
      "subteam"
    ]);
    expect(representativeAgent.value.surfaces?.moltnet).toEqual([
      {
        contextRooms: {
          [parentTeam.value.source]: ["research"]
        },
        memberId: "placeholder",
        network: "local_lab",
        rooms: {
          research: {}
        },
        teamSource: parentTeam.value.source
      }
    ]);
  });

  it("rejects cyclic subagent graphs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-cycle-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "subagents", "loop"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(path.join(directory, "subagents", "loop", "AGENTS.md"), "# Loop\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "",
        "subagents:",
        "  - id: loop",
        "    ref: ./subagents/loop",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "subagents", "loop", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: loop",
        "",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "",
        "subagents:",
        "  - id: self",
        "    ref: .",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/Cycle detected/);
  });

  it("reuses repeated agent refs when the resolved context is identical", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-duplicate-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "shared"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "shared", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "agents", "shared", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: shared", "", "runtime: openclaw", "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: team",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: one",
        "    ref: ./agents/shared",
        "  - id: two",
        "    ref: ./agents/shared",
        "",
        "mode: swarm",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    expect(plan.nodes.filter((node) => node.kind === "agent")).toHaveLength(1);
  });

  it("rejects agents that do not declare a runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-missing-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: root", "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/does not declare a runtime/);
  });

  it("rejects runtime and model auth combinations that the adapter does not support", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-unsupported-auth-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: tinyclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: openai",
        "      name: gpt-5",
        "    auth:",
        "      method: claude-code",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /does not support model auth method claude-code for provider openai/
    );
  });

  it("rejects runtime and surface access combinations that the adapter does not support", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-unsupported-surface-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: tinyclaw",
        "",
        "surfaces:",
        "  discord:",
        "    access:",
        "      mode: allowlist",
        '      users:',
        '        - "987654321098765432"',
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /TinyClaw Discord only supports pairing access/
    );
  });

  it("rejects runtimes that cannot preserve multiple interactive conversation scopes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-interactive-scopes-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: tinyclaw",
        "",
        "surfaces:",
        "  discord:",
        "    access:",
        "      mode: pairing",
        "  telegram:",
        "    access:",
        "      mode: pairing",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /only one interactive conversation scope/
    );
  });

  it("accepts custom and local model targets on runtimes that support them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-custom-models-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: picoclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: custom",
        "      name: foo-large",
        "      auth:",
        "        method: api_key",
        "        key: CUSTOM_API_KEY",
        "      endpoint:",
        "        compatibility: anthropic",
        "        base_url: https://llm.example.com/v1",
        "    fallback:",
        "      - provider: local",
        "        name: qwen2.5:14b",
        "        auth:",
        "          method: none",
        "        endpoint:",
        "          compatibility: openai",
        "          base_url: http://host.docker.internal:11434/v1",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    expect(plan.nodes).toHaveLength(1);
  });

  it("rejects unknown runtime bindings during graph resolution", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-unknown-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: mysteryclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/Unknown runtime binding/);
  });

  it("rejects exploratory runtimes before adapter execution", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-exploratory-runtime-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: nullclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/exploratory/);
  });

  it("rejects subagents whose local runtime differs from the parent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-subagent-runtime-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "subagents", "worker"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(path.join(directory, "subagents", "worker", "AGENTS.md"), "# Worker\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "",
        "subagents:",
        "  - id: worker",
        "    ref: ./subagents/worker",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "subagents", "worker", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "",
        "runtime: picoclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/must match parent runtime/);
  });

  it("rejects subagent refs that point to team manifests", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-subagent-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "subagents", "team"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Root\n");
    await writeUtf8File(path.join(directory, "subagents", "team", "TEAM.md"), "# Team\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: root",
        "",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        "",
        "subagents:",
        "  - id: worker",
        "    ref: ./subagents/team",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "subagents", "team", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: nested-team",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members: []",
        "",
        "mode: swarm",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(/Expected agent manifest, got team/);
  });

  it("reuses repeated nested team refs when the resolved context is identical", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-duplicate-team-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "teams", "inner", "agents", "a"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "teams", "inner", "TEAM.md"), "# Inner\n");
    await writeUtf8File(path.join(directory, "teams", "inner", "agents", "a", "AGENTS.md"), "# A\n");
    await writeUtf8File(
      path.join(directory, "teams", "inner", "agents", "a", "Spawnfile"),
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: tinyclaw", "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "teams", "inner", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: inner",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: a",
        "    ref: ./agents/a",
        "",
        "mode: swarm",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: outer",
        "",
        "workspace:",
        "  docs:",
        "    system: TEAM.md",
        "",
        "members:",
        "  - id: one",
        "    ref: ./teams/inner",
        "  - id: two",
        "    ref: ./teams/inner",
        "",
        "mode: swarm",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    expect(plan.nodes.filter((node) => node.kind === "team")).toHaveLength(2);
  });
});
