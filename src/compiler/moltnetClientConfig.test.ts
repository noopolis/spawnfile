import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";
import { manifestSchema, renderSpawnfile } from "../manifest/index.js";
import { buildCompilePlan } from "./buildCompilePlan.js";
import { renderEntrypoint } from "./containerEntrypointRender.js";
import {
  createMoltnetClientConfigFiles,
  resolveMoltnetWorkspaceLayout
} from "./moltnetClientConfig.js";
import { generateMoltnetArtifacts, type MoltnetArtifacts } from "./moltnetArtifacts.js";
import type { ResolvedAgentNode } from "./types.js";

const actor = (id: "blue" | "red") => ({
  id, runtime: "pi" as const, workspace: { docs: { system: `${id}.md` } },
  surfaces: { moltnet: [{ network: "pitch", auth: { token_id: id }, rooms: { field: {} }, dms: { enabled: true } }] }
});
const b31Manifest = manifestSchema.parse({
  spawnfile_version: "0.1", kind: "team", name: "tiny-football", mode: "swarm",
  members: [actor("red"), actor("blue")],
  networks: [{
    id: "pitch", provider: "moltnet",
    server: {
      mode: "managed", listen: { bind: "127.0.0.1", port: 8787 }, store: { kind: "memory" }, direct_messages: true,
      auth: { mode: "bearer", client: { token_id: "operator" }, tokens: [
        { id: "operator", secret: "OPERATOR_TOKEN_ENV", scopes: ["admin", "observe", "write"] },
        { id: "blue", secret: "BLUE_TOKEN_ENV", scopes: ["attach", "write"], agents: ["blue"] },
        { id: "red", secret: "RED_TOKEN_ENV", scopes: ["attach", "write"], agents: ["red"] },
        { id: "world", secret: "WORLD_TOKEN_ENV", scopes: ["attach", "write"], agents: ["world"] }
      ] }
    },
    rooms: [{ id: "field", members: ["blue", "red"] }]
  }],
  external_participants: [{
    id: "world", kind: "service",
    surfaces: { moltnet: [{ network: "pitch", auth: { token_id: "world" }, dms: { enabled: true } }] }
  }]
});

const createArtifacts = (): MoltnetArtifacts => ({
  files: [],
  nodePlans: [],
  persistentMounts: [],
  ports: [8787],
  publishedPorts: [],
  serverPlans: [
    {
      baseUrl: "http://127.0.0.1:8787",
      id: "research-cell-local_lab",
      mode: "managed",
      name: "Local Lab",
      networkId: "local_lab",
      port: 8787,
      rooms: [
        {
          id: "research",
          members: ["orchestrator"],
          visibility: "public",
          write_policy: "members"
        }
      ],
      server: {
        auth: { mode: "none" },
        listen: { bind: "127.0.0.1", port: 8787 },
        mode: "managed",
        store: { kind: "memory" }
      },
      secretPatches: [],
      teamSource: "/tmp/team/Spawnfile"
    }
  ]
});

const createAgent = (runtime: "openclaw" | "picoclaw" | "pi"): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name: "orchestrator",
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: runtime, options: {} },
  secrets: [],
  skills: [],
  source: "/tmp/agents/orchestrator/Spawnfile",
  surfaces: {
    moltnet: [
      {
        dms: {
          enabled: true,
          wake: "never"
        },
        memberId: "orchestrator",
        network: "local_lab",
        rooms: {
          research: {
            wake: "all"
          }
        },
        teamSource: "/tmp/team/Spawnfile"
      }
    ]
  },
  subagents: []
});

describe("moltnetClientConfig", () => {
  it("emits a workspace config file for openclaw", () => {
    const files = createMoltnetClientConfigFiles(createAgent("openclaw"), createArtifacts());

    expect(files.map((file) => file.path)).toEqual(["workspace/.moltnet/config.json"]);
    expect(files[0]?.content).toContain('"base_url": "http://127.0.0.1:8787"');
    expect(files[0]?.content).toContain('"member_id": "orchestrator"');
    expect(files[0]?.content).toContain('"visibility": "public"');
    expect(files[0]?.content).toContain('"write_policy": "members"');
    expect(createHash("sha256").update(files[0]?.content ?? "").digest("hex"))
      .toBe("c749110941941164fe3ebf01c9e5b763037e1094ffde2ff03280b1ef92b82775");
  });

  it("resolves the workspace skill layout for picoclaw", () => {
    expect(resolveMoltnetWorkspaceLayout("picoclaw", "orchestrator")).toEqual({
      clientConfigPath: "workspace/.moltnet/config.json",
      cliRuntime: "picoclaw",
      skillPaths: ["workspace/skills/moltnet/SKILL.md"],
      workspaceRootPath: "workspace"
    });
  });

  it("resolves the Codex-style workspace skill layout for pi", () => {
    expect(resolveMoltnetWorkspaceLayout("pi", "orchestrator")).toEqual({
      clientConfigPath: "workspace/.moltnet/config.json",
      cliRuntime: "codex",
      skillPaths: [
        "workspace/.agents/skills/moltnet/SKILL.md",
        "workspace/.codex/skills/moltnet/SKILL.md"
      ],
      workspaceRootPath: "workspace"
    });

    const files = createMoltnetClientConfigFiles(createAgent("pi"), createArtifacts());
    expect(files.map((file) => file.path)).toEqual(["workspace/.moltnet/config.json"]);
    expect(files[0]?.content).toContain('"runtime": "pi"');
  });

  it("returns no files when the agent has no moltnet attachments", () => {
    const agent = createAgent("picoclaw");
    agent.surfaces = undefined;

    expect(createMoltnetClientConfigFiles(agent, createArtifacts())).toEqual([]);
  });

  it("omits optional room and dm sections when the attachment does not declare them", () => {
    const agent = createAgent("openclaw");
    agent.surfaces = {
      moltnet: [
        {
          memberId: "orchestrator",
          network: "local_lab",
          rooms: undefined,
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    const files = createMoltnetClientConfigFiles(agent, createArtifacts());

    expect(files[0]?.content).not.toContain('"rooms"');
    expect(files[0]?.content).not.toContain('"dms"');
  });

  it("omits optional policy fields when room and dm policies leave them unset", () => {
    const agent = createAgent("openclaw");
    agent.surfaces = {
      moltnet: [
        {
          dms: {
            enabled: true
          },
          memberId: "orchestrator",
          network: "local_lab",
          rooms: {
            research: {}
          },
          teamSource: "/tmp/team/Spawnfile"
        }
      ]
    };

    const files = createMoltnetClientConfigFiles(agent, createArtifacts());

    expect(files[0]?.content).toContain('"enabled": true');
    expect(files[0]?.content).not.toContain('"reply":');
    expect(files[0]?.content).not.toContain('"read":');
  });

  it("fails when the attachment member id is missing", () => {
    const agent = createAgent("openclaw");
    if (agent.surfaces?.moltnet?.[0]) {
      agent.surfaces.moltnet[0].memberId = null;
    }

    expect(() => createMoltnetClientConfigFiles(agent, createArtifacts())).toThrow(
      /requires a resolved member id/
    );
  });

  it("fails when an attachment cannot be matched to a generated server plan", () => {
    const artifacts = createArtifacts();
    artifacts.serverPlans = [];

    expect(() => createMoltnetClientConfigFiles(createAgent("openclaw"), artifacts)).toThrow(
      /Unable to resolve Moltnet server plan/
    );
  });

  it("falls back to the shared network server plan when a representative context has a different team source", () => {
    const agent = createAgent("openclaw");
    if (agent.surfaces?.moltnet?.[0]) {
      agent.surfaces.moltnet[0].teamSource = "/tmp/child/Spawnfile";
    }

    const files = createMoltnetClientConfigFiles(agent, createArtifacts());

    expect(files[0]?.content).toContain('"base_url": "http://127.0.0.1:8787"');
    expect(files[0]?.content).toContain('"network_id": "local_lab"');
  });

  it("uses the compiled agent slug for generated open-registration token paths", () => {
    const artifacts = createArtifacts();
    const [serverPlan] = artifacts.serverPlans;
    if (serverPlan) {
      serverPlan.server = {
        ...serverPlan.server,
        auth: {
          mode: "bearer",
          agent_registration: "open",
          public_read: true
        }
      };
    }
    const agent = createAgent("openclaw");

    const files = createMoltnetClientConfigFiles(agent, artifacts, "agent-slug");

    expect(files[0]?.content)
      .toContain('"token_path": "/var/lib/spawnfile/agents/agent-slug/state/moltnet/local_lab-orchestrator.token"');
    expect(files[0]?.content)
      .not.toContain("/var/lib/spawnfile/agents/orchestrator/state/moltnet/local_lab-orchestrator.token");
  });

  it("projects an explicitly selected actor token into the client config", () => {
    const artifacts = createArtifacts();
    const [serverPlan] = artifacts.serverPlans;
    if (serverPlan) {
      serverPlan.server = {
        ...serverPlan.server,
        auth: {
          mode: "bearer",
          client: { token_id: "operator" },
          tokens: [
            { id: "operator", secret: "OPERATOR_TOKEN", scopes: ["admin", "observe", "write"] },
            { id: "actor", secret: "ACTOR_TOKEN", scopes: ["attach", "write"], agents: ["orchestrator"] }
          ]
        }
      };
    }
    const agent = createAgent("openclaw");
    if (agent.surfaces?.moltnet?.[0]) agent.surfaces.moltnet[0].auth = { tokenId: "actor" };
    const content = createMoltnetClientConfigFiles(agent, artifacts)[0]?.content ?? "";
    expect(content).toContain('"token_env": "ACTOR_TOKEN"');
    expect(content).not.toContain("OPERATOR_TOKEN");
  });

  it("fails when the runtime does not have a Moltnet workspace layout", () => {
    expect(() => resolveMoltnetWorkspaceLayout("mysteryclaw", "orchestrator")).toThrow(
      /does not know how to emit files for runtime mysteryclaw/
    );
  });

  it("carries B31 identity and actor auth from canonical source to secret-free artifacts", async () => {
    const rendered = renderSpawnfile(b31Manifest);
    const roots: string[] = [];
    const envNames = ["BLUE_TOKEN_ENV", "RED_TOKEN_ENV", "WORLD_TOKEN_ENV", "OPERATOR_TOKEN_ENV"];
    const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    envNames.forEach((name) => { process.env[name] = `actual-${name}-must-not-emit`; });
    try {
      for (let index = 0; index < 2; index += 1) {
        const root = await mkdtemp(path.join(os.tmpdir(), `spawnfile-b31-${index}-`));
        roots.push(root);
        await Promise.all([
          writeUtf8File(path.join(root, "Spawnfile"), rendered),
          writeUtf8File(path.join(root, "blue.md"), "# Blue\n"),
          writeUtf8File(path.join(root, "red.md"), "# Red\n")
        ]);
      }
      const [first, second] = await Promise.all(roots.map((root) => buildCompilePlan(root)));
      expect(rendered.indexOf("networks:")).toBeLessThan(rendered.indexOf("members:"));
      expect(rendered.indexOf("members:")).toBeLessThan(rendered.indexOf("external_participants:"));
      const external = rendered.lastIndexOf("- network: pitch");
      expect(["auth:", "dms:"].map((key) => rendered.indexOf(key, external)))
        .toEqual(["auth:", "dms:"].map((key) => rendered.indexOf(key, external)).sort((a, b) => a - b));
      expect(first.organizationIdentity).toEqual(second.organizationIdentity);
      expect(first.organizationIdentity?.agentMembers.map((member) => member.memberId)).toEqual(["blue", "red"]);
      expect(first.organizationIdentity?.externalParticipants).toEqual([
        { authoredParticipantKey: "world", kind: "service", memberId: "world", principalId: "system:world" }
      ]);
      expect(first.moltnetExternalParticipantIntents?.[0]?.directMessagePeers).toEqual(["blue", "red"]);

      const plans = [first, second];
      const generated = await Promise.all(plans.map((plan) => generateMoltnetArtifacts(plan)));
      const artifacts = generated[0];
      if (!artifacts || !generated[1]) throw new Error("expected Moltnet artifacts");
      const externalFile = artifacts.files.find((file) => file.path === "moltnet/external-participants/pitch/world.json");
      expect(externalFile?.path.startsWith("container/rootfs/")).toBe(false);
      expect(externalFile).toEqual(generated[1].files.find((file) => file.path === externalFile?.path));
      expect(createHash("sha256").update(externalFile?.content ?? "").digest("hex"))
        .toBe("6cc56ad01bddb13ada0fd56eb171449676a728251f77480d5f354ea7d8762065");

      const agents = first.nodes.filter((node) => node.kind === "agent");
      expect(Object.values(first.runtimes).flatMap((runtime) => runtime.nodeIds).sort())
        .toEqual(agents.map((node) => node.id).sort());
      expect(artifacts.serverPlans[0]?.rooms[0]?.members).toEqual(["blue", "red"]);
      expect(artifacts.nodePlans).toHaveLength(2);
      expect(artifacts.nodePlans.some((node) => node.configPath.endsWith("-world.json"))).toBe(false);
      const evidence = [...artifacts.files.map((file) => file.content)];
      for (const node of agents) {
        const agent = node.value as ResolvedAgentNode;
        const member = agent.surfaces?.moltnet?.[0]?.memberId;
        expect(agent.surfaces?.moltnet?.[0]).toMatchObject({ auth: { tokenId: member }, memberId: member });
        const nodeFile = artifacts.files.find((file) => file.path.endsWith(`-${member}.json`));
        expect(JSON.parse(nodeFile?.content ?? "{}")).toMatchObject({
          moltnet: { token_env: `${member?.toUpperCase()}_TOKEN_ENV` }, attachments: [{ agent: { id: member } }]
        });
        expect(nodeFile?.content).not.toContain("OPERATOR_TOKEN_ENV");
        const workspace = createMoltnetClientConfigFiles(agent, artifacts, node.slug)[0]?.content ?? "";
        expect(JSON.parse(workspace).attachments[0]).toMatchObject({
          member_id: member, auth: { token_env: `${member?.toUpperCase()}_TOKEN_ENV` }
        });
        expect(workspace).not.toContain("OPERATOR_TOKEN_ENV");
        evidence.push(workspace);
      }
      expect(evidence.join("\n")).not.toContain("actual-");
      const entrypoint = renderEntrypoint([], [], { hasMoltnet: true, moltnet: artifacts });
      expect(entrypoint.match(/\/usr\/local\/bin\/moltnet node/g)).toHaveLength(2);
      expect(entrypoint).not.toContain("external-participants");
    } finally {
      await Promise.all(roots.map((root) => removeDirectory(root)));
      envNames.forEach((name) => {
        const value = previous[name];
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      });
    }
  });
});
