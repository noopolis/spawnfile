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

  it("supports OpenClaw hook payloads on /team/message", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("body.agentId");
    expect(script).toContain("body.sessionKey");
    expect(script).toContain("target agent required");
    expect(script).toContain("delivered: false");
    expect(script).toContain("sendOpenClawHook");
    expect(script).toContain("/hooks/agent");
    expect(script).toContain("OPENCLAW_HOOKS_TOKEN");
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

  it("contains shared runtime command helper", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('require("node:child_process")');
    expect(script).toContain("runCommand");
    expect(script).toContain("buildSessionId");
  });

  it("dispatches based on route runtime", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('route.runtime === "tinyclaw"');
  });

  it("contains OpenClaw CLI send function", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("sendOpenClaw");
    expect(script).toContain('["agent", "--session-id", sessionId, "--message", message, "--json"]');
    expect(script).toContain("OPENCLAW_CONFIG_PATH");
    expect(script).toContain('body.sessionKey || body.context_id');
  });

  it("contains PicoClaw CLI send function", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("sendPicoClaw");
    expect(script).toContain('["agent", "--session", sessionId, "--message", message]');
    expect(script).toContain("PICOCLAW_CONFIG");
  });

  it("dispatches openclaw route to sendOpenClaw", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('route.runtime === "openclaw"');
  });

  it("dispatches picoclaw route to sendPicoClaw", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain('route.runtime === "picoclaw"');
  });

  it("parses PicoClaw CLI output and strips ANSI noise", () => {
    const script = generateSurfaceRouterScript();
    expect(script).toContain("parsePicoClawOutput");
    expect(script).toContain("stripAnsi");
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
    expect(config.routes[0].runtimeHomePath).toBe(
      "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi"
    );
    expect(config.routes[0].runtimeConfigPath).toBe(
      "/var/lib/spawnfile/instances/tinyclaw/tinyclaw-runtime/tinyagi/settings.json"
    );
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
    expect(config.routes[0].runtimeHomePath).toBe(
      "/var/lib/spawnfile/instances/openclaw/agent-oc-agent/home"
    );
    expect(config.routes[0].runtimeConfigPath).toBe(
      "/var/lib/spawnfile/instances/openclaw/agent-oc-agent/home/.openclaw/openclaw.json"
    );
    expect(config.routes[0].runtime).toBe("openclaw");
  });

  it("assigns distinct default ports to multiple openclaw agents", () => {
    const alpha = makeAgentNode("alpha", "/project/alpha/Spawnfile", "openclaw");
    const beta = makeAgentNode("beta", "/project/beta/Spawnfile", "openclaw");
    const gamma = makeAgentNode("gamma", "/project/gamma/Spawnfile", "openclaw");

    const teamNode = makeTeamNode({
      members: [
        { id: "alpha", kind: "agent", nodeSource: "/project/alpha/Spawnfile", runtimeName: "openclaw" },
        { id: "beta", kind: "agent", nodeSource: "/project/beta/Spawnfile", runtimeName: "openclaw" },
        { id: "gamma", kind: "agent", nodeSource: "/project/gamma/Spawnfile", runtimeName: "openclaw" }
      ]
    });

    const plan = makePlan([
      { node: alpha, slug: "alpha" },
      { node: beta, slug: "beta" },
      { node: gamma, slug: "gamma" }
    ]);
    const config = generateRouterConfig(teamNode, plan, 9100);

    expect(config.routes.map((route) => route.runtimeUrl)).toEqual([
      "ws://localhost:18789",
      "ws://localhost:18809",
      "ws://localhost:18829"
    ]);
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
    expect(config.routes[0].runtimeHomePath).toBe(
      "/var/lib/spawnfile/instances/picoclaw/agent-pc-agent/picoclaw"
    );
    expect(config.routes[0].runtimeConfigPath).toBe(
      "/var/lib/spawnfile/instances/picoclaw/agent-pc-agent/picoclaw/config.json"
    );
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
    expect(ocRoute?.runtimeConfigPath).toBe(
      "/var/lib/spawnfile/instances/openclaw/agent-oc/home/.openclaw/openclaw.json"
    );
    expect(pcRoute?.runtime).toBe("picoclaw");
    expect(pcRoute?.runtimeUrl).toBe("ws://localhost:18790/pico/ws");
    expect(pcRoute?.runtimeConfigPath).toBe(
      "/var/lib/spawnfile/instances/picoclaw/agent-pc/picoclaw/config.json"
    );
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
