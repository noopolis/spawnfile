import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDirectory, removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";

const fixturesRoot = path.resolve(process.cwd(), "examples");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeDirectory(directory)));
});

describe("buildCompilePlan", () => {
  it("builds a single-agent plan", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-single-agent-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Agent\n");
    await writeUtf8File(path.join(directory, "IDENTITY.md"), "# Identity\n");
    await writeUtf8File(path.join(directory, "SOUL.md"), "# Soul\n");
    await writeUtf8File(path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: analyst",
        "",
        "runtime: openclaw",
        "",
        "execution:",
        "  model:",
        "    primary:",
        "      provider: anthropic",
        "      name: claude-sonnet-4-5",
        "  sandbox:",
        "    mode: workspace",
        "",
        "workspace:",
        "  docs:",
        "    identity: IDENTITY.md",
        "    soul: SOUL.md",
        "    system: AGENTS.md",
        "",
        "policy:",
        "  mode: warn",
        "  on_degrade: warn",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);

    expect(plan.nodes).toHaveLength(1);
    expect(plan.runtimes.openclaw.nodeIds).toHaveLength(1);
  });

  it("compiles mixed inline and referenced agents with stable identities", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-inline-agents-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "coach"));
    await ensureDirectory(path.join(directory, "characters"));
    await writeUtf8File(path.join(directory, "characters", "red.md"), "# Red player\n");
    await writeUtf8File(path.join(directory, "characters", "blue.md"), "# Blue player\n");
    await writeUtf8File(path.join(directory, "agents", "coach", "AGENTS.md"), "# Coach\n");
    await writeUtf8File(
      path.join(directory, "agents", "coach", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: coach",
        "runtime: openclaw",
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
        "name: tiny-football",
        "mode: swarm",
        "shared:",
        "  environment:",
        "    env:",
        "      MATCH: training",
        "members:",
        "  - id: red",
        "    runtime: openclaw",
        "    workspace:",
        "      docs:",
        "        system: ./characters/red.md",
        "    environment:",
        "      env:",
        "        COLOR: red",
        "    surfaces:",
        "      moltnet:",
        "        - network: pitch",
        "          rooms:",
        "            field:",
        "              wake: mentions",
        "  - id: blue",
        "    runtime: pi",
        "    workspace:",
        "      docs:",
        "        system: ./characters/blue.md",
        "    surfaces:",
        "      moltnet:",
        "        - network: pitch",
        "          rooms:",
        "            field:",
        "              wake: mentions",
        "  - id: coach",
        "    ref: ./agents/coach",
        "memory:",
        "  - id: match-memory",
        "    access:",
        "      members: [red, blue]",
        "    store:",
        "      kind: memory",
        "networks:",
        "  - id: pitch",
        "    name: Match Pitch",
        "    provider: moltnet",
        "    server:",
        "      mode: external",
        "      url: http://127.0.0.1:8787",
        "      auth:",
        "        mode: none",
        "    rooms:",
        "      - id: field",
        "        members: [red, blue]",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const repeatedPlan = await buildCompilePlan(directory);
    const teamSource = path.join(directory, "Spawnfile");
    const red = plan.nodes.find((node) => node.value.name === "red");
    const blue = plan.nodes.find((node) => node.value.name === "blue");
    const coach = plan.nodes.find((node) => node.value.name === "coach");

    expect(repeatedPlan).toEqual(plan);
    expect(plan.nodes).toHaveLength(4);
    expect(plan.runtimes.openclaw.nodeIds).toHaveLength(2);
    expect(plan.runtimes.pi.nodeIds).toHaveLength(1);
    expect(red?.value).toMatchObject({
      docs: [{ content: "# Red player\n", role: "system" }],
      env: { COLOR: "red", MATCH: "training" },
      source: `${teamSource}#member=red`,
      sourcePath: teamSource
    });
    expect(blue?.value).toMatchObject({
      docs: [{ content: "# Blue player\n", role: "system" }],
      source: `${teamSource}#member=blue`,
      sourcePath: teamSource
    });
    expect(coach?.value.source).toBe(path.join(directory, "agents", "coach", "Spawnfile"));
    expect(plan.memoryAccess?.map((access) => access.agentSource).sort()).toEqual([
      `${teamSource}#member=blue`,
      `${teamSource}#member=red`
    ]);
    expect(plan.moltnetRoomMemberships?.map((entry) => entry.agentSource).sort()).toEqual([
      `${teamSource}#member=blue`,
      `${teamSource}#member=red`
    ]);
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
        "    resources:",
        "      - id: project",
        "        kind: git",
        "        url: https://example.com/project.git",
        "        branch: main",
        "        mount: ./repos/project",
        "        mode: mutable",
        "      - id: dropbox",
        "        kind: volume",
        "        mount: ./shared",
        "        mode: mutable",
        "        sharing: team",
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
        "      mount: ./cache",
        "      mode: mutable",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const team = plan.nodes.find((node) => node.kind === "team");
    const agent = plan.nodes.find((node) => node.kind === "agent");

    expect(team?.value.workspaceResources).toEqual([
      expect.objectContaining({
        id: "dropbox",
        kind: "volume",
        mode: "mutable",
        mount: "./shared",
        sharing: "team",
        scope: expect.objectContaining({
          kind: "team",
          name: "lab"
        })
      }),
      expect.objectContaining({
        branch: "main",
        id: "project",
        kind: "git",
        mode: "mutable",
        mount: "./repos/project",
        sharing: "per_agent",
        scope: expect.objectContaining({
          kind: "team",
          name: "lab"
        }),
        url: "https://example.com/project.git"
      })
    ]);
    expect(agent?.value.workspaceResources).toEqual([
      expect.objectContaining({
        id: "cache",
        kind: "volume",
        mode: "mutable",
        mount: "./cache",
        sharing: "per_agent",
        scope: expect.objectContaining({
          kind: "agent",
          name: "worker"
        })
      }),
      expect.objectContaining({
        id: "dropbox",
        kind: "volume",
        mode: "mutable",
        mount: "./shared",
        sharing: "team",
        scope: expect.objectContaining({
          kind: "team",
          name: "lab"
        })
      }),
      expect.objectContaining({
        branch: "main",
        id: "project",
        kind: "git",
        mode: "mutable",
        mount: "./repos/project",
        sharing: "per_agent",
        scope: expect.objectContaining({
          kind: "team",
          name: "lab"
        }),
        url: "https://example.com/project.git"
      })
    ]);
  });

  it("loads inherited shared workspace docs and merges environment packages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-shared-workspace-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "researcher"));
    await writeUtf8File(path.join(directory, "TEAM.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "TEAM_POLICY.md"), "# Team policy\n");
    await writeUtf8File(path.join(directory, "TEAM_ID.md"), "# Team Identity\n");
    await writeUtf8File(path.join(directory, "agents", "researcher", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: researcher",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    identity: AGENT_ID.md",
        "    extras:",
        "      agent: AGENT_NOTES.md",
        "    system: AGENTS.md",
        "  skills: []",
        "",
        "environment:",
        "  packages:",
        "    - id: curl-agent",
        "      manager: apt",
        "      name: curl",
        "      version: \"9.0\"",
        "    - id: shared-npm",
        "      manager: npm",
        "      name: \"@openai/codex\"",
        "      version: \"0.128\"",
        "      scope: global",
        ""
      ].join("\n")
    );
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENT_ID.md"), "# Researcher\n");
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENT_NOTES.md"), "# Research notes\n");
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: research-cell",
        "mode: hierarchical",
        "lead: researcher",
        "shared:",
        "  workspace:",
        "    docs:",
        "      identity: TEAM_ID.md",
        "      extras:",
        "        team: TEAM_POLICY.md",
        "  environment:",
        "    packages:",
        "      - id: curl-team",
        "        manager: apt",
        "        name: curl",
        "        version: \"8.9\"",
        "    secrets: []",
        "    mcp_servers: []",
        "members:",
        "  - id: researcher",
        "    ref: ./agents/researcher",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const team = plan.nodes.find((node) => node.kind === "team");
    const agent = plan.nodes.find((node) => node.kind === "agent");

    if (!team || team.value.kind !== "team" || !agent || agent.value.kind !== "agent") {
      throw new Error("Expected agent and team nodes");
    }

    expect(team.value.docs.find((doc) => doc.role === "identity")?.content).toBe("# Team Identity\n");
    expect(agent.value.docs.find((doc) => doc.role === "identity")?.content).toBe("# Researcher\n");
    expect(agent.value.docs.find((doc) => doc.role === "extras.team")?.content).toBe(
      "# Team policy\n"
    );
    expect(agent.value.packages).toEqual([
      {
        id: "curl-agent",
        manager: "apt",
        name: "curl",
        version: "9.0"
      },
      {
        id: "shared-npm",
        manager: "npm",
        name: "@openai/codex",
        version: "0.128",
        scope: "global"
      }
    ]);
  });

  it("compiles one canonical agent imported by multiple nested teams into Moltnet rooms", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-canonical-imports-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "eleanor"));
    for (const team of ["office", "eleanor-family", "friends-group"]) {
      await ensureDirectory(path.join(directory, "teams", team));
      await writeUtf8File(path.join(directory, "teams", team, "TEAM.md"), `# ${team}\n`);
      await writeUtf8File(
        path.join(directory, "teams", team, "Spawnfile"),
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          `name: ${team}`,
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
          "members:",
          "  - id: eleanor",
          "    ref: ../../agents/eleanor",
          "mode: swarm",
          "external: [eleanor]"
        ].join("\n")
      );
    }
    await writeUtf8File(path.join(directory, "agents", "eleanor", "AGENTS.md"), "# Eleanor\n");
    await writeUtf8File(
      path.join(directory, "agents", "eleanor", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: eleanor",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: office-sim",
        "members:",
        "  - id: office",
        "    ref: ./teams/office",
        "  - id: eleanor-family",
        "    ref: ./teams/eleanor-family",
        "  - id: friends-group",
        "    ref: ./teams/friends-group",
        "mode: swarm",
        "networks:",
        "  - id: social-world",
        "    name: Social World",
        "    provider: moltnet",
        "    server:",
        "      mode: managed",
        "      listen:",
        "        bind: 127.0.0.1",
        "        port: 19910",
        "      store:",
        "        kind: sqlite",
        "      auth:",
        "        mode: open",
        "        public_read: true",
        "    rooms:",
        "      - id: office-hall",
        "        members: [office]",
        "      - id: eleanor-home",
        "        members: [eleanor-family]",
        "      - id: after-work-chat",
        "        members: [friends-group]"
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const eleanorNodes = plan.nodes.filter((node) =>
      node.kind === "agent" && node.value.name === "eleanor"
    );
    const eleanor = eleanorNodes[0]?.value;

    expect(eleanorNodes).toHaveLength(1);
    expect(eleanor.kind === "agent" ? eleanor.docs.map((doc) => doc.content) : []).toEqual([
      "# Eleanor\n"
    ]);
    expect(plan.memberships?.filter((entry) => entry.memberId === "eleanor")).toHaveLength(3);
    expect(plan.moltnetRoomMemberships?.filter((entry) =>
      entry.concreteMemberId === "eleanor"
    ).map((entry) => entry.roomId).sort()).toEqual([
      "after-work-chat",
      "eleanor-home",
      "office-hall"
    ]);
    expect(eleanor.kind === "agent" ? eleanor.surfaces?.moltnet : undefined).toEqual([
      expect.objectContaining({
        memberId: "eleanor",
        network: "social-world",
        rooms: expect.objectContaining({
          "after-work-chat": expect.any(Object),
          "eleanor-home": expect.any(Object),
          "office-hall": expect.any(Object)
        })
      })
    ]);
  });

  it("merges compatible shared resources when the same agent is imported by multiple teams", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-canonical-resource-imports-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "eleanor"));
    await writeUtf8File(path.join(directory, "agents", "eleanor", "AGENTS.md"), "# Eleanor\n");
    await writeUtf8File(
      path.join(directory, "agents", "eleanor", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: eleanor",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );

    for (const [team, resource, mount] of [
      ["office", "office-notes", "./office-notes"],
      ["family", "family-notes", "./family-notes"]
    ] as const) {
      await ensureDirectory(path.join(directory, "teams", team));
      await writeUtf8File(path.join(directory, "teams", team, "TEAM.md"), `# ${team}\n`);
      await writeUtf8File(
        path.join(directory, "teams", team, "Spawnfile"),
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          `name: ${team}`,
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
          "    resources:",
          `      - id: ${resource}`,
          "        kind: volume",
          `        mount: ${mount}`,
          "        mode: mutable",
          "members:",
          "  - id: eleanor",
          "    ref: ../../agents/eleanor",
          "mode: swarm"
        ].join("\n")
      );
    }
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: social-root",
        "members:",
        "  - id: office",
        "    ref: ./teams/office",
        "  - id: family",
        "    ref: ./teams/family",
        "mode: swarm"
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const eleanor = plan.nodes.find((node) =>
      node.kind === "agent" && node.value.name === "eleanor"
    );

    expect(eleanor?.value.workspaceResources?.map((resource) => resource.id).sort()).toEqual([
      "family-notes",
      "office-notes"
    ]);
  });

  it("rejects conflicting shared resources for the same imported agent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-canonical-conflict-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "eleanor"));
    await writeUtf8File(path.join(directory, "agents", "eleanor", "AGENTS.md"), "# Eleanor\n");
    await writeUtf8File(
      path.join(directory, "agents", "eleanor", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: eleanor",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );

    for (const [team, mount] of [
      ["office", "./office-notes"],
      ["family", "./family-notes"]
    ] as const) {
      await ensureDirectory(path.join(directory, "teams", team));
      await writeUtf8File(path.join(directory, "teams", team, "TEAM.md"), `# ${team}\n`);
      await writeUtf8File(
        path.join(directory, "teams", team, "Spawnfile"),
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          `name: ${team}`,
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
          "    resources:",
          "      - id: notes",
          "        kind: volume",
          `        mount: ${mount}`,
          "        mode: mutable",
          "members:",
          "  - id: eleanor",
          "    ref: ../../agents/eleanor",
          "mode: swarm"
        ].join("\n")
      );
    }
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: social-root",
        "members:",
        "  - id: office",
        "    ref: ./teams/office",
        "  - id: family",
        "    ref: ./teams/family",
        "mode: swarm"
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /Workspace resource notes resolves differently/
    );
  });

  it("rejects conflicting shared environment for the same imported agent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-canonical-env-conflict-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "eleanor"));
    await writeUtf8File(path.join(directory, "agents", "eleanor", "AGENTS.md"), "# Eleanor\n");
    await writeUtf8File(
      path.join(directory, "agents", "eleanor", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: eleanor",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );

    for (const [team, mood] of [
      ["office", "work"],
      ["family", "home"]
    ] as const) {
      await ensureDirectory(path.join(directory, "teams", team));
      await writeUtf8File(path.join(directory, "teams", team, "TEAM.md"), `# ${team}\n`);
      await writeUtf8File(
        path.join(directory, "teams", team, "Spawnfile"),
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          `name: ${team}`,
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
          "  environment:",
          "    env:",
          `      MOOD: ${mood}`,
          "members:",
          "  - id: eleanor",
          "    ref: ../../agents/eleanor",
          "mode: swarm"
        ].join("\n")
      );
    }
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: social-root",
        "members:",
        "  - id: office",
        "    ref: ./teams/office",
        "  - id: family",
        "    ref: ./teams/family",
        "mode: swarm"
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /conflicting environment variable MOOD/
    );
  });

  it("allows local environment packages to override inherited package versions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-package-override-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "researcher"));
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENT_ID.md"), "# Researcher\n");
    await writeUtf8File(path.join(directory, "agents", "researcher", "AGENTS.md"), "# Agent\n");
    await writeUtf8File(
      path.join(directory, "agents", "researcher", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: researcher",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    identity: AGENT_ID.md",
        "    system: AGENTS.md",
        "  ",
        "environment:",
        "  packages:",
        "    - id: curl-agent",
        "      manager: apt",
        "      name: curl",
        "      version: \"9.0\"",
        ""
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: research-cell",
        "mode: hierarchical",
        "lead: researcher",
        "shared:",
        "  environment:",
        "    packages:",
        "      - id: curl-team",
        "        manager: apt",
        "        name: curl",
        "        version: \"8.9\"",
        "members:",
        "  - id: researcher",
        "    ref: ./agents/researcher",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agent = plan.nodes.find((node) => node.kind === "agent");

    if (!agent || agent.value.kind !== "agent") {
      throw new Error("Expected agent node");
    }

    expect(agent.value.packages).toEqual([
      {
        id: "curl-agent",
        manager: "apt",
        name: "curl",
        version: "9.0"
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
        "shared:",
        "  workspace:",
        "    resources:",
        "      - id: project",
        "        kind: volume",
        "        mount: ./work/project",
        "        mode: mutable",
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
        "      mount: ./work/project/docs",
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
      ["writer", "picoclaw"]
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

    const plan = await buildCompilePlan(directory);

    expect(Object.keys(plan.runtimes).sort()).toEqual(["openclaw", "picoclaw"]);
    expect(plan.nodes.find((node) => node.kind === "team")).toBeTruthy();
  });

  it("attaches agent-level memory declarations to agent access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-agent-memory-"));
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
        "memory:",
        "  - id: self",
        "    store:",
        "      kind: sqlite",
        "      path: /var/lib/spawnfile/memory/self.sqlite",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const agent = plan.nodes.find((node) => node.kind === "agent");
    const memoryAccess = plan.memoryAccess?.filter((entry) => entry.bank.id === "self");

    expect(agent).toBeDefined();
    expect(memoryAccess).toHaveLength(1);
    expect(memoryAccess?.[0]).toMatchObject({
      agentSource: agent?.value.source,
      declaringKind: "agent",
      source: agent?.value.source,
      bank: {
        id: "self",
        declaredBy: "agent",
        store: {
          kind: "sqlite",
          path: "/var/lib/spawnfile/memory/self.sqlite"
        }
      }
    });
  });

  it("canonicalizes sqlite memory defaults in resolved bank entries", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-agent-memory-defaults-"));
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
        "memory:",
        "  - id: self",
        "    store:",
        "      kind: sqlite",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const memoryAccess = plan.memoryAccess?.filter((entry) => entry.bank.id === "self");

    expect(memoryAccess).toHaveLength(1);
    expect(memoryAccess?.[0]).toMatchObject({
      bank: {
        store: {
          kind: "sqlite",
          persistence: {
            mode: "durable"
          },
          path: "/var/lib/spawnfile/memory/root/self/memory.sqlite"
        }
      }
    });
  });

  it("defaults team memory access to direct concrete member slots only", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-memory-default-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "worker"));
    await ensureDirectory(path.join(directory, "teams", "nested"));
    await ensureDirectory(path.join(directory, "teams", "nested", "agents", "nested-agent"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Worker\n");
    await writeUtf8File(path.join(directory, "agents", "worker", "AGENTS.md"), "# Worker\n");
    await writeUtf8File(
      path.join(directory, "agents", "worker", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );
    await writeUtf8File(path.join(directory, "teams", "nested", "AGENTS.md"), "# Nested Team\n");
    await writeUtf8File(path.join(directory, "teams", "nested", "agents", "nested-agent", "AGENTS.md"), "# Delegate\n");
    await writeUtf8File(
      path.join(directory, "teams", "nested", "agents", "nested-agent", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: nested-agent",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "teams", "nested", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: nested",
        "",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: AGENTS.md",
        "members:",
        "  - id: nested-member",
        "    ref: ./agents/nested-agent",
        "mode: swarm"
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: outer",
        "",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: AGENTS.md",
        "members:",
        "  - id: worker",
        "    ref: ./agents/worker",
        "  - id: nested",
        "    ref: ./teams/nested",
        "memory:",
        "  - id: shared",
        "    store:",
        "      kind: json",
        "      path: /var/lib/spawnfile/memory/shared.jsonl",
        "mode: swarm"
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const outerTeam = plan.nodes.find((node) => node.kind === "team" && node.value.name === "outer");
    if (!outerTeam) {
      throw new Error("expected outer team node");
    }

    const memoryAccess = (plan.memoryAccess ?? []).filter((entry) => entry.bank.id === "shared");
    const workerAgentNode = plan.nodes.find((node) => node.kind === "agent" && node.value.name === "worker");
    const nestedAgentNode = plan.nodes.find((node) => node.kind === "agent" && node.value.name === "nested-agent");
    if (!workerAgentNode || !nestedAgentNode) {
      throw new Error("expected both agent nodes");
    }

    expect(memoryAccess).toHaveLength(1);
    expect(memoryAccess[0]?.agentSource).toBe(workerAgentNode.value.source);
    expect(memoryAccess[0]?.declaringKind).toBe("team");
    expect(memoryAccess[0]?.slotId).toBe("worker");
    expect(memoryAccess[0]?.source).toBe(outerTeam.value.source);

    const agentSourceSet = new Set(memoryAccess.map((entry) => entry.agentSource));
    expect(agentSourceSet).toEqual(new Set([workerAgentNode.value.source]));
  });

  it("applies team memory access lists to only listed direct slots", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-memory-filter-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "researcher"));
    await ensureDirectory(path.join(directory, "agents", "critic"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Team\n");
    await writeUtf8File(
      path.join(directory, "agents", "researcher", "AGENTS.md"),
      "# Researcher\n"
    );
    await writeUtf8File(
      path.join(directory, "agents", "critic", "AGENTS.md"),
      "# Critic\n"
    );
    await writeUtf8File(
      path.join(directory, "agents", "researcher", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: researcher",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "agents", "critic", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: critic",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: review-cell",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: AGENTS.md",
        "members:",
        "  - id: researcher",
        "    ref: ./agents/researcher",
        "  - id: critic",
        "    ref: ./agents/critic",
        "memory:",
        "  - id: reviews",
        "    access:",
        "      members: [critic]",
        "    store:",
        "      kind: memory",
        "mode: swarm"
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    const criticNode = plan.nodes.find((node) => node.kind === "agent" && node.value.name === "critic");
    const researcherNode = plan.nodes.find((node) => node.kind === "agent" && node.value.name === "researcher");
    if (!criticNode || !researcherNode) {
      throw new Error("expected both agent nodes");
    }

    const access = (plan.memoryAccess ?? []).filter((entry) => entry.bank.id === "reviews");
    expect(access).toHaveLength(1);
    expect(access[0]?.agentSource).toBe(criticNode.value.source);
    expect(access[0]?.slotId).toBe("critic");
    expect(access[0]?.agentSource).not.toBe(researcherNode.value.source);
  });

  it("rejects team memory access entries that reference unknown member slots", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-team-memory-invalid-slot-"));
    temporaryDirectories.push(directory);

    await ensureDirectory(path.join(directory, "agents", "worker"));
    await writeUtf8File(path.join(directory, "AGENTS.md"), "# Team\n");
    await writeUtf8File(path.join(directory, "agents", "worker", "AGENTS.md"), "# Worker\n");
    await writeUtf8File(
      path.join(directory, "agents", "worker", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: worker",
        "runtime: openclaw",
        "",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md"
      ].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: bad-team",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: AGENTS.md",
        "members:",
        "  - id: worker",
        "    ref: ./agents/worker",
        "memory:",
        "  - id: bad",
        "    access:",
        "      members: [ghost]",
        "    store:",
        "      kind: memory",
        "mode: swarm"
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /references unknown member ghost/
    );
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
        "          wake: mentions",
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
            wake: "mentions"
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
        "          wake: mentions",
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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

  it("allows duplicate member ids across teams when slots resolve to one canonical agent source", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-canonical-agent-across-teams-"));
    temporaryDirectories.push(directory);

    await writeUtf8File(path.join(directory, "TEAM.md"), "# Root\n");

    await ensureDirectory(path.join(directory, "agents", "eleanor"));
    await writeUtf8File(path.join(directory, "agents", "eleanor", "AGENTS.md"), "# Eleanor\n");
    await writeUtf8File(
      path.join(directory, "agents", "eleanor", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: agent",
        "name: canonical-eleanor",
        "runtime: openclaw",
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    for (const team of ["office", "family", "friends"]) {
      await ensureDirectory(path.join(directory, "teams", team));
      await writeUtf8File(path.join(directory, "teams", team, "TEAM.md"), `# ${team}\n`);
      await writeUtf8File(
        path.join(directory, `teams/${team}/Spawnfile`),
        [
          'spawnfile_version: "0.1"',
          "kind: team",
          `name: ${team}`,
          "",
          "shared:",
          "  workspace:",
          "    docs:",
          "      system: TEAM.md",
          "",
          "members:",
          "  - id: eleanor",
          "    ref: ../../agents/eleanor",
          "",
          "mode: swarm",
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
          "      - id: main",
          "        members: [eleanor]",
          ""
        ].join("\n")
      );
    }

    await writeUtf8File(
      path.join(directory, "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: mesh",
        "",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
        "",
        "members:",
        "  - id: office",
        "    ref: ./teams/office",
        "  - id: family",
        "    ref: ./teams/family",
        "  - id: friends",
        "    ref: ./teams/friends",
        "",
        "mode: swarm",
        ""
      ].join("\n")
    );

    const plan = await buildCompilePlan(directory);
    expect(plan.nodes.filter((node) => node.kind === "agent")).toHaveLength(1);
    expect(plan.memberships?.filter((membership) => membership.memberId === "eleanor")).toHaveLength(3);
    const agentSource = path.join(directory, "agents", "eleanor", "Spawnfile");
    expect(plan.memberships?.every((membership) => membership.agentSource === agentSource)).toBeTruthy();
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
          research: {
            wake: "mentions"
          }
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
        "runtime: picoclaw",
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
        "runtime: picoclaw",
        "",
        "surfaces:",
        "  discord:",
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
      /PicoClaw Discord does not support pairing access/
    );
  });

  it("rejects removed runtime bindings", async () => {
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
        "workspace:",
        "  docs:",
        "    system: AGENTS.md",
        ""
      ].join("\n")
    );

    await expect(buildCompilePlan(directory)).rejects.toThrow(
      /Unknown runtime binding: tinyclaw/
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
        "runtime: openfang",
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
      ['spawnfile_version: "0.1"', "kind: agent", "name: a", "", "runtime: picoclaw", "", "workspace:", "  docs:", "    system: AGENTS.md", ""].join("\n")
    );
    await writeUtf8File(
      path.join(directory, "teams", "inner", "Spawnfile"),
      [
        'spawnfile_version: "0.1"',
        "kind: team",
        "name: inner",
        "",
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
        "shared:",
        "  workspace:",
        "    docs:",
        "      system: TEAM.md",
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
