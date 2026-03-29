import { describe, expect, it } from "vitest";

import { generateRouterConfig, generateSurfaceRouterScript } from "./surfaceRouter.js";
import { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";

const makeAgentNode = (
  name: string,
  source: string,
  runtimeName: string,
  surfaces?: ResolvedAgentNode["surfaces"]
): ResolvedAgentNode => ({
  description: `${name} agent`,
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name,
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: runtimeName, options: {} },
  secrets: [],
  skills: [],
  source,
  subagents: [],
  ...(surfaces ? { surfaces } : {})
});

const makeTeamNode = (overrides: Partial<ResolvedTeamNode> = {}): ResolvedTeamNode => ({
  auth: null,
  description: "Test team",
  docs: [],
  external: [],
  kind: "team",
  lead: null,
  members: [],
  mode: "swarm",
  name: "test-team",
  policyMode: null,
  policyOnDegrade: null,
  shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
  source: "/project/Spawnfile",
  ...overrides
});

const makePlan = (agents: Array<{ node: ResolvedAgentNode; slug: string }>): CompilePlan => ({
  edges: [],
  nodes: agents.map((a) => ({
    id: `agent:${a.slug}`,
    kind: "agent" as const,
    runtimeName: a.node.runtime.name,
    slug: a.slug,
    value: a.node
  })),
  root: "/project/Spawnfile",
  runtimes: {}
});

describe("generateSurfaceRouterScript", () => {
  it("returns a non-empty string", () => {
    const script = generateSurfaceRouterScript();
    expect(script.length).toBeGreaterThan(0);
  });

  it("returns syntactically valid JavaScript", () => {
    const script = generateSurfaceRouterScript();
    expect(() => new Function(script)).not.toThrow();
  });

  it("contains handler for /health", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("/health");
  });

  it("contains handler for /team/message", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("/team/message");
  });

  it("contains handler for /route/ path", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("\\/route\\/");
    expect(script).toContain("\\/v1\\/messages");
  });

  it("uses node:http and node:fs built-ins", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('require("node:http")');
    expect(script).toContain('require("node:fs")');
  });

  it("reads config from CLI arg", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("process.argv[2]");
  });

  it("contains TinyClaw async send function", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("sendTinyClaw");
    expect(script).toContain("/api/responses/pending");
    expect(script).toContain("/ack");
  });

  it("contains default synchronous send function", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("sendDefault");
  });

  it("dispatches based on route runtime", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('route.runtime === "tinyclaw"');
  });

  it("contains OpenClaw WebSocket send function", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("sendOpenClaw");
    expect(script).toContain("chat.send");
    expect(script).toContain("idempotencyKey");
    expect(script).toContain("sessionKey");
  });

  it("contains PicoClaw WebSocket send function", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("sendPicoClaw");
    expect(script).toContain('type: "message"');
    expect(script).toContain("Authorization");
  });

  it("dispatches openclaw route to sendOpenClaw", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('route.runtime === "openclaw"');
    expect(script).toContain("OPENCLAW_GATEWAY_TOKEN");
  });

  it("dispatches picoclaw route to sendPicoClaw", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('route.runtime === "picoclaw"');
    expect(script).toContain("PICOCLAW_PICO_TOKEN");
  });

  it("uses global WebSocket for OpenClaw and PicoClaw", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("new WebSocket(wsUrl)");
    expect(script).toContain("new WebSocket(wsUrl, { headers: headers })");
  });
});

describe("generateRouterConfig", () => {
  it("builds routes from team members", () => {
    const alice = makeAgentNode("alice", "/project/alice/Spawnfile", "openclaw");
    const bob = makeAgentNode("bob", "/project/bob/Spawnfile", "openclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "alice", kind: "agent", nodeSource: "/project/alice/Spawnfile", runtimeName: "openclaw" },
        { id: "bob", kind: "agent", nodeSource: "/project/bob/Spawnfile", runtimeName: "openclaw" }
      ]
    });

    const plan = makePlan([
      { node: alice, slug: "alice" },
      { node: bob, slug: "bob" }
    ]);

    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.port).toBe(9100);
    expect(config.routes).toHaveLength(2);
    expect(config.routes.map((r) => r.agentId).sort()).toEqual(["alice", "bob"]);
  });

  it("includes teamAuthSecret when team.auth is present", () => {
    const agent = makeAgentNode("a", "/project/a/Spawnfile", "openclaw");

    const teamNode = makeTeamNode({
      auth: { mode: "shared_secret", secret: "MY_SECRET" },
      members: [
        { id: "a", kind: "agent", nodeSource: "/project/a/Spawnfile", runtimeName: "openclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "a" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.teamAuthSecret).toBe("MY_SECRET");
  });

  it("omits teamAuthSecret when team.auth is null", () => {
    const agent = makeAgentNode("a", "/project/a/Spawnfile", "openclaw");

    const teamNode = makeTeamNode({
      auth: null,
      members: [
        { id: "a", kind: "agent", nodeSource: "/project/a/Spawnfile", runtimeName: "openclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "a" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.teamAuthSecret).toBeUndefined();
  });

  it("uses TinyClaw-specific URL for tinyclaw agents", () => {
    const agent = makeAgentNode("claw-agent", "/project/claw/Spawnfile", "tinyclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "claw-agent", kind: "agent", nodeSource: "/project/claw/Spawnfile", runtimeName: "tinyclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "claw-agent" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].runtimeUrl).toBe("http://localhost:3777/api/message");
    expect(config.routes[0].runtime).toBe("tinyclaw");
  });

  it("uses WebSocket URL for openclaw agents", () => {
    const agent = makeAgentNode("oc-agent", "/project/oc/Spawnfile", "openclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "oc-agent", kind: "agent", nodeSource: "/project/oc/Spawnfile", runtimeName: "openclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "oc-agent" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].runtimeUrl).toBe("ws://localhost:18789");
    expect(config.routes[0].runtime).toBe("openclaw");
  });

  it("uses WebSocket URL for picoclaw agents", () => {
    const agent = makeAgentNode("pc-agent", "/project/pc/Spawnfile", "picoclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "pc-agent", kind: "agent", nodeSource: "/project/pc/Spawnfile", runtimeName: "picoclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "pc-agent" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].runtimeUrl).toBe("ws://localhost:18790/pico/ws");
    expect(config.routes[0].runtime).toBe("picoclaw");
  });

  it("uses portable HTTP URL for unknown runtimes", () => {
    const agent = makeAgentNode("other-agent", "/project/other/Spawnfile", "someclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "other-agent", kind: "agent", nodeSource: "/project/other/Spawnfile", runtimeName: "someclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "other-agent" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].runtimeUrl).toBe("http://localhost:8080/v1/messages");
    expect(config.routes[0].runtime).toBe("someclaw");
  });

  it("respects custom http port for openclaw WebSocket URL", () => {
    const agent = makeAgentNode("custom", "/project/custom/Spawnfile", "openclaw", {
      http: { pathPrefix: "/v1", port: 3000 }
    });

    const teamNode = makeTeamNode({
      members: [
        { id: "custom", kind: "agent", nodeSource: "/project/custom/Spawnfile", runtimeName: "openclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "custom" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes[0].runtimeUrl).toBe("ws://localhost:3000");
  });

  it("respects custom http port for picoclaw WebSocket URL", () => {
    const agent = makeAgentNode("custom-pc", "/project/custom-pc/Spawnfile", "picoclaw", {
      http: { pathPrefix: "/v1", port: 4000 }
    });

    const teamNode = makeTeamNode({
      members: [
        { id: "custom-pc", kind: "agent", nodeSource: "/project/custom-pc/Spawnfile", runtimeName: "picoclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "custom-pc" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes[0].runtimeUrl).toBe("ws://localhost:4000/pico/ws");
  });

  it("respects custom pathPrefix for unknown runtimes", () => {
    const agent = makeAgentNode("prefix", "/project/prefix/Spawnfile", "someclaw", {
      http: { pathPrefix: "/api/v2", port: 8080 }
    });

    const teamNode = makeTeamNode({
      members: [
        { id: "prefix", kind: "agent", nodeSource: "/project/prefix/Spawnfile", runtimeName: "someclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "prefix" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes[0].runtimeUrl).toBe("http://localhost:8080/api/v2/messages");
  });

  it("skips team members that are not agents", () => {
    const agent = makeAgentNode("lead", "/project/lead/Spawnfile", "openclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "lead", kind: "agent", nodeSource: "/project/lead/Spawnfile", runtimeName: "openclaw" },
        { id: "sub-team", kind: "team", nodeSource: "/project/sub/Spawnfile", runtimeName: null }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "lead" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].agentId).toBe("lead");
  });

  it("includes runtime field and correct URLs for mixed-runtime teams", () => {
    const tcAgent = makeAgentNode("tc", "/project/tc/Spawnfile", "tinyclaw");
    const ocAgent = makeAgentNode("oc", "/project/oc/Spawnfile", "openclaw");
    const pcAgent = makeAgentNode("pc", "/project/pc/Spawnfile", "picoclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "tc", kind: "agent", nodeSource: "/project/tc/Spawnfile", runtimeName: "tinyclaw" },
        { id: "oc", kind: "agent", nodeSource: "/project/oc/Spawnfile", runtimeName: "openclaw" },
        { id: "pc", kind: "agent", nodeSource: "/project/pc/Spawnfile", runtimeName: "picoclaw" }
      ]
    });

    const plan = makePlan([
      { node: tcAgent, slug: "tc" },
      { node: ocAgent, slug: "oc" },
      { node: pcAgent, slug: "pc" }
    ]);

    const config = generateRouterConfig(teamNode, plan, 9100);
    const tcRoute = config.routes.find((r) => r.agentId === "tc");
    const ocRoute = config.routes.find((r) => r.agentId === "oc");
    const pcRoute = config.routes.find((r) => r.agentId === "pc");

    expect(tcRoute?.runtime).toBe("tinyclaw");
    expect(tcRoute?.runtimeUrl).toBe("http://localhost:3777/api/message");
    expect(ocRoute?.runtime).toBe("openclaw");
    expect(ocRoute?.runtimeUrl).toBe("ws://localhost:18789");
    expect(pcRoute?.runtime).toBe("picoclaw");
    expect(pcRoute?.runtimeUrl).toBe("ws://localhost:18790/pico/ws");
  });

  it("uses tinyclaw custom port when specified", () => {
    const agent = makeAgentNode("tc", "/project/tc/Spawnfile", "tinyclaw", {
      http: { pathPrefix: "/v1", port: 4000 }
    });

    const teamNode = makeTeamNode({
      members: [
        { id: "tc", kind: "agent", nodeSource: "/project/tc/Spawnfile", runtimeName: "tinyclaw" }
      ]
    });

    const plan = makePlan([{ node: agent, slug: "tc" }]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes[0].runtimeUrl).toBe("http://localhost:4000/api/message");
  });
});
