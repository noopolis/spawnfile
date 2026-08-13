import { describe, expect, it } from "vitest";

import type { TeamNetworkServer } from "../manifest/index.js";

import type { MoltnetArtifacts } from "./moltnetArtifactTypes.js";
import { createMoltnetClientConfigFiles } from "./moltnetClientConfig.js";
import { createMoltnetNodeConfigContent } from "./moltnetNodeConfig.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedMoltnetAttachment } from "./types.js";

const createAgent = (
  runtime: "openclaw" | "pi",
  surfaces: ResolvedAgentNode["surfaces"]
): ResolvedAgentNode => ({
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
  surfaces,
  subagents: []
});

const createArtifacts = (): MoltnetArtifacts => ({
  files: [],
  nodePlans: [],
  persistentMounts: [],
  ports: [8787],
  publishedPorts: [],
  serverPlans: [{
    baseUrl: "http://127.0.0.1:8787",
    id: "research-cell-local_lab",
    mode: "managed",
    name: "Local Lab",
    networkId: "local_lab",
    rooms: [],
    server: serverConfig,
    secretPatches: [],
    teamSource: "/tmp/team/Spawnfile"
  }]
});

const serverConfig: TeamNetworkServer = {
  mode: "managed",
  auth: {
    mode: "bearer",
    client: { token_id: "orchestrator" },
    tokens: [{ id: "orchestrator", secret: "ACTOR_TOKEN", scopes: ["attach", "write"], agents: ["orchestrator"] }]
  },
  direct_messages: true,
  listen: { bind: "127.0.0.1", port: 8787 },
  store: { kind: "memory" }
};

const createNodePlan = (): CompilePlan => ({
  edges: [],
  nodes: [
    {
      id: "agent",
      kind: "agent",
      runtimeName: "openclaw",
      slug: "orchestrator",
      value: createAgent("openclaw", {
        moltnet: [{
          memberId: "orchestrator",
          network: "local_lab",
          dms: { enabled: true, wake: "never", allowedWakeSenders: ["world"] },
          teamSource: "/tmp/team/Spawnfile"
        }]
      })
    }
  ],
  root: "/tmp/team/Spawnfile",
  runtimes: { openclaw: { nodeIds: ["agent"] } }
});

const createNodeAttachment = (
  allowedWakeSenders?: string[]
): ResolvedMoltnetAttachment & { memberId: string } => ({
  memberId: "orchestrator",
  network: "local_lab",
  teamSource: "/tmp/team/Spawnfile",
  dms: {
    ...(allowedWakeSenders === undefined ? {} : { allowedWakeSenders }),
    enabled: true,
    wake: "never"
  }
});

const nodeConfigFor = (
  attachment: ResolvedMoltnetAttachment & { memberId: string },
  plan?: CompilePlan
): string => {
  const localPlan = plan ?? createNodePlan();
  const agent = localPlan.nodes[0]?.value;
  if (agent.kind !== "agent") throw new Error("expected agent node");

  return createMoltnetNodeConfigContent({
    agentNode: agent,
    attachment,
    networkServer: serverConfig,
    nodeSlug: "orchestrator",
    plan: localPlan,
    serverPlan: {
      baseUrl: "http://127.0.0.1:8787",
      rooms: []
    }
  }).content;
};

describe("moltnet W2a policy lowering", () => {
  it("emits client dms without allowed_wake_senders when absent", () => {
    const agent = createAgent("openclaw", {
      moltnet: [{
        dms: { enabled: true, wake: "never" },
        memberId: "orchestrator",
        network: "local_lab",
        teamSource: "/tmp/team/Spawnfile"
      }]
    });

    const nodeAttachment = createNodeAttachment();
    const files = createMoltnetClientConfigFiles(agent, createArtifacts());
    const content = files[0]?.content ?? "";
    const nodeContent = nodeConfigFor(nodeAttachment);
    const clientDms = JSON.parse(content).attachments?.[0]?.dms ?? {};
    const nodeDms = JSON.parse(nodeContent).attachments?.[0]?.dms ?? {};

    expect(clientDms).toEqual({ enabled: true, wake: "never" });
    expect(nodeDms).toEqual(clientDms);
    expect(content).not.toContain("allowed_wake_senders");
    expect(nodeContent).not.toContain("allowed_wake_senders");
  });

  it("treats absent allowed_wake_senders identically in parsed client and node dms payloads", () => {
    const agent = createAgent("openclaw", {
      moltnet: [{
        dms: { enabled: true, wake: "never" },
        memberId: "orchestrator",
        network: "local_lab",
        teamSource: "/tmp/team/Spawnfile"
      }]
    });
    const nodeAttachment = createNodeAttachment();
    const clientContent = createMoltnetClientConfigFiles(agent, createArtifacts())[0]?.content ?? "";
    const nodeContent = nodeConfigFor(nodeAttachment, createNodePlan());
    const clientDms = JSON.parse(clientContent).attachments?.[0]?.dms;
    const nodeDms = JSON.parse(nodeContent).attachments?.[0]?.dms;

    expect(clientDms?.allowed_wake_senders).toBeUndefined();
    expect(nodeDms?.allowed_wake_senders).toBeUndefined();
  });

  it("preserves explicit empty allowed_wake_senders in ordered dms output", () => {
    const agent = createAgent("openclaw", {
      moltnet: [{
        dms: { enabled: true, wake: "never", allowedWakeSenders: [] },
        memberId: "orchestrator",
        network: "local_lab",
        teamSource: "/tmp/team/Spawnfile"
      }]
    });
    const content = createMoltnetClientConfigFiles(agent, createArtifacts())[0]?.content ?? "";
    const dms = content.indexOf('"dms": {');
    const enabled = content.indexOf('"enabled": true', dms);
    const wake = content.indexOf('"wake": "never"', dms);
    const allowed = content.indexOf('"allowed_wake_senders": [', dms);
    const expected = {
      enabled: true,
      wake: "never",
      allowed_wake_senders: []
    };
    const nodeAttachment = createNodeAttachment([]);
    const nodeContent = nodeConfigFor(nodeAttachment);

    expect(dms).toBeGreaterThan(-1);
    expect(enabled).toBeLessThan(wake);
    expect(wake).toBeLessThan(allowed);
    expect(content).toContain('"allowed_wake_senders": []');
    expect(JSON.parse(content).attachments?.[0]?.dms).toEqual(expected);
    expect(JSON.parse(nodeContent).attachments?.[0]?.dms).toEqual(expected);
  });

  it("preserves ordered allowed_wake_senders for client and node lowering", () => {
    const nodeAttachment = createNodeAttachment(["world", "alpha"]);
    const clientAgent = createAgent("openclaw", {
      moltnet: [nodeAttachment]
    });
    const clientContent = createMoltnetClientConfigFiles(clientAgent, createArtifacts())[0]?.content ?? "";
    const nodeContent = nodeConfigFor(nodeAttachment);
    const clientDms = JSON.parse(clientContent).attachments?.[0]?.dms ?? {};
    const nodeDms = JSON.parse(nodeContent).attachments?.[0]?.dms ?? {};

    expect(clientDms).toEqual({
      enabled: true,
      wake: "never",
      allowed_wake_senders: ["world", "alpha"]
    });
    expect(nodeDms).toEqual(clientDms);
  });

  it("preserves ordered nonempty allowed_wake_senders as parsed dms payloads", () => {
    const nodeAttachment = createNodeAttachment(["world", "alpha"]);
    const clientAgent = createAgent("openclaw", {
      moltnet: [nodeAttachment]
    });
    const clientContent = createMoltnetClientConfigFiles(clientAgent, createArtifacts())[0]?.content ?? "";
    const nodeContent = nodeConfigFor(nodeAttachment);
    const clientDms = JSON.parse(clientContent).attachments?.[0]?.dms ?? {};
    const nodeDms = JSON.parse(nodeContent).attachments?.[0]?.dms ?? {};

    expect(clientDms).toEqual({
      enabled: true,
      wake: "never",
      allowed_wake_senders: ["world", "alpha"]
    });
    expect(nodeDms).toEqual(clientDms);
  });

  it("does not share allowed_wake_senders arrays across caller and emitted client/node outputs", () => {
    const allowedWakeSenders = ["world"];
    const attachment = createNodeAttachment(allowedWakeSenders);
    const clientAgent = createAgent("openclaw", { moltnet: [attachment] });
    const clientContent = createMoltnetClientConfigFiles(clientAgent, createArtifacts())[0]?.content ?? "";
    const nodeContent = nodeConfigFor(attachment, createNodePlan());

    allowedWakeSenders.push("other");

    expect(JSON.parse(clientContent).attachments[0].dms.allowed_wake_senders).toEqual(["world"]);
    expect(JSON.parse(nodeContent).attachments[0].dms.allowed_wake_senders).toEqual(["world"]);
  });
});
