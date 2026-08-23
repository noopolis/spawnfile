import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import { resolveOrganizationIdentity } from "./organizationIdentity.js";
import {
  findWorldBindingForNode,
  parseSimfileWorldBindings,
  renderSimfileWorldBindings,
  resolveWorldBindings,
  SIMFILE_WORLD_BINDINGS_VERSION,
  type SimfileWorldBindingsV1
} from "./worldBindings.js";
import {
  loadWorldBindingsForCompile,
  MAX_WORLD_BINDINGS_FILE_BYTES,
  readSimfileWorldBindingsFile
} from "./worldBindingsFile.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const entry = (member: "blue" | "red") => ({
  member: { id: member, principal_id: `agent:${member}` },
  run_id: "run-2026-07-21",
  world_instance_id: "pitch-instance-1",
  capability_manifest_digest: digest(member === "red" ? "a" : "b"),
  token_env: `TINY_FOOTBALL_${member.toUpperCase()}_WORLD_TOKEN`,
  json: { auth: "bearer", url: "http://simfile-world:19972/v1/world" },
  mcp: { auth: "bearer", transport: "streamable_http", url: "http://simfile-world:19972/mcp" }
});

const artifact = (order: Array<"blue" | "red"> = ["red", "blue"]): SimfileWorldBindingsV1 => ({
  schema: SIMFILE_WORLD_BINDINGS_VERSION,
  bindings: order.map(entry)
} as SimfileWorldBindingsV1);

const agent = (name: string, source: string): ResolvedAgentNode => ({
  description: "",
  docs: [],
  env: {},
  execution: undefined,
  kind: "agent",
  mcpServers: [],
  name,
  policyMode: null,
  policyOnDegrade: null,
  runtime: { name: "pi", options: { engine: "pi" } },
  secrets: [],
  skills: [],
  source,
  subagents: []
});

const plan = (root = "/org/Spawnfile"): CompilePlan => {
  const redSource = `${root}/red`;
  const blueSource = `${root}/blue`;
  const team: ResolvedTeamNode = {
    description: "",
    docs: [],
    external: [],
    externalParticipants: [{
      id: "world",
      kind: "service",
      surfaces: { moltnet: [{ network: "pitch", auth: { token_id: "world" }, dms: { enabled: true } }] }
    }],
    kind: "team",
    lead: null,
    members: [
      { id: "red", kind: "agent", nodeSource: redSource, runtimeName: "pi" },
      { id: "blue", kind: "agent", nodeSource: blueSource, runtimeName: "pi" }
    ],
    mode: "swarm",
    name: "football",
    policyMode: null,
    policyOnDegrade: null,
    shared: { env: {}, mcpServers: [], secrets: [], skills: [] },
    source: root
  };
  return {
    edges: [
      { from: "team:football", kind: "team_member", label: "red", to: "runtime:red" },
      { from: "team:football", kind: "team_member", label: "blue", to: "runtime:blue" }
    ],
    nodes: [
      { id: "team:football", kind: "team", runtimeName: null, slug: "football", value: team },
      { id: "runtime:red", kind: "agent", runtimeName: "pi", slug: "display-red", value: agent("Red Display", redSource) },
      { id: "runtime:blue", kind: "agent", runtimeName: "pi", slug: "display-blue", value: agent("Blue Display", blueSource) }
    ],
    organizationIdentity: {
      agentMembers: [
        { authoredMemberKey: "blue", kind: "agent", memberId: "blue", principalId: "agent:blue" },
        { authoredMemberKey: "red", kind: "agent", memberId: "red", principalId: "agent:red" }
      ],
      externalParticipants: [
        { authoredParticipantKey: "world", kind: "service", memberId: "world", principalId: "system:world" }
      ]
    },
    root,
    runtimes: { pi: { nodeIds: ["runtime:red", "runtime:blue"] } }
  };
};

describe("simfile.world-bindings.v1", () => {
  it("canonicalizes order, freezes the result, and renders stable secret-free bytes", () => {
    const first = parseSimfileWorldBindings(artifact(["red", "blue"]));
    const second = parseSimfileWorldBindings(artifact(["blue", "red"]));
    expect(first).toEqual(second);
    expect(first.bindings.map((binding) => binding.member.id)).toEqual(["blue", "red"]);
    expect([
      first,
      first.bindings,
      first.bindings[0],
      first.bindings[0]?.member,
      first.bindings[0]?.json,
      first.bindings[0]?.mcp
    ].every(Object.isFrozen)).toBe(true);
    const canary = "world-bearer-secret-canary";
    const previous = process.env.TINY_FOOTBALL_RED_WORLD_TOKEN;
    process.env.TINY_FOOTBALL_RED_WORLD_TOKEN = canary;
    try {
      const bytes = renderSimfileWorldBindings(first);
      expect(bytes).toBe(renderSimfileWorldBindings(second));
      expect(bytes.endsWith("\n")).toBe(true);
      expect(bytes).not.toContain(canary);
      expect(bytes).toContain('"token_env": "TINY_FOOTBALL_RED_WORLD_TOKEN"');
    } finally {
      if (previous === undefined) delete process.env.TINY_FOOTBALL_RED_WORLD_TOKEN;
      else process.env.TINY_FOOTBALL_RED_WORLD_TOKEN = previous;
    }
  });

  it("loads one bounded file and joins its run to the compile run exactly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-bindings-"));
    const filePath = path.join(directory, "bindings.json");
    try {
      await writeFile(filePath, JSON.stringify(artifact()), "utf8");
      const resolved = await loadWorldBindingsForCompile(plan(), filePath, "run-2026-07-21");
      expect(resolved.artifact.bindings).toHaveLength(2);
      await expect(loadWorldBindingsForCompile(plan(), filePath, "other-run"))
        .rejects.toThrow(/does not match/u);
      await expect(loadWorldBindingsForCompile(plan(), filePath, undefined))
        .rejects.toThrow(/NOOPOLIS_RUN_ID/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects decoded duplicate keys without echoing hostile file content", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-bindings-"));
    const filePath = path.join(directory, "bindings.json");
    const canary = "secret-duplicate-key-canary";
    try {
      const encoded = JSON.stringify(artifact()).replace(
        '"id":"red"',
        `"id":"red","\\u0069d":"${canary}"`
      );
      await writeFile(filePath, encoded, "utf8");
      let message = "";
      try {
        await readSimfileWorldBindingsFile(filePath);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/duplicate JSON keys/u);
      expect(message).not.toContain(canary);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects invalid UTF-8, multiple values, empty files, and oversized files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-bindings-"));
    const filePath = path.join(directory, "bindings.json");
    try {
      await writeFile(filePath, Uint8Array.from([0xc3, 0x28]));
      await expect(readSimfileWorldBindingsFile(filePath)).rejects.toThrow(/valid UTF-8/u);
      await writeFile(filePath, `${JSON.stringify(artifact())}\n${JSON.stringify(artifact())}`);
      await expect(readSimfileWorldBindingsFile(filePath)).rejects.toThrow(/exactly one/u);
      await writeFile(filePath, "");
      await expect(readSimfileWorldBindingsFile(filePath)).rejects.toThrow(/non-empty/u);
      await writeFile(filePath, " ".repeat(MAX_WORLD_BINDINGS_FILE_BYTES + 1));
      await expect(readSimfileWorldBindingsFile(filePath)).rejects.toThrow(/no larger/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")("rejects a FIFO without waiting for a writer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-world-bindings-"));
    const fifoPath = path.join(directory, "bindings.fifo");
    try {
      execFileSync("mkfifo", [fifoPath]);
      const moduleUrl = new URL("./worldBindingsFile.ts", import.meta.url).href;
      const script = [
        `const { readSimfileWorldBindingsFile } = await import(${JSON.stringify(moduleUrl)});`,
        "try {",
        "  await readSimfileWorldBindingsFile(process.argv[1]);",
        "  process.exitCode = 2;",
        "} catch (error) {",
        "  if (!(error instanceof Error) || !error.message.includes('non-empty regular file')) process.exitCode = 3;",
        "}"
      ].join("\n");
      const result = spawnSync(process.execPath, [
        "--import", "tsx", "--input-type=module", "--eval", script, fifoPath
      ], { encoding: "utf8", timeout: 2_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("accepts arbitrary object-key order and duplicate manifest digests", () => {
    const raw = structuredClone(artifact()) as unknown as {
      bindings: Array<Record<string, unknown>>;
      schema: string;
    };
    raw.bindings = raw.bindings.map((binding) => Object.fromEntries(
      Object.entries(binding).reverse()
    ));
    raw.bindings[1]!.capability_manifest_digest = raw.bindings[0]!.capability_manifest_digest;
    expect(parseSimfileWorldBindings({ bindings: raw.bindings, schema: raw.schema }).bindings)
      .toHaveLength(2);
  });

  it("joins only the B31 member and principal authority across source/name changes", () => {
    const first = resolveWorldBindings(plan("/first/root"), artifact());
    const second = resolveWorldBindings(plan("/unrelated/other-root"), artifact());
    expect(first.canonicalBytes).toBe(second.canonicalBytes);
    expect(first.assignments.map(({ binding, nodeId }) => [binding.member.id, nodeId])).toEqual([
      ["blue", "runtime:blue"],
      ["red", "runtime:red"]
    ]);
    expect(findWorldBindingForNode(first, "runtime:red")?.token_env)
      .toBe("TINY_FOOTBALL_RED_WORLD_TOKEN");
    expect(findWorldBindingForNode(first, "runtime:blue")?.token_env)
      .toBe("TINY_FOOTBALL_BLUE_WORLD_TOKEN");
    expect(findWorldBindingForNode(first, "unscoped-agent")).toBeUndefined();
    expect(Object.isFrozen(first.assignments[0]?.binding)).toBe(true);
  });

  it("joins every agent in an ordinary organization with zero external participants", () => {
    const current = plan();
    const root = current.nodes.find((node) => node.kind === "team")?.value as ResolvedTeamNode;
    root.externalParticipants = undefined;
    current.organizationIdentity = resolveOrganizationIdentity(current);
    expect(current.organizationIdentity?.externalParticipants).toEqual([]);
    expect(resolveWorldBindings(current, artifact()).assignments.map(({ nodeId }) => nodeId))
      .toEqual(["runtime:blue", "runtime:red"]);
  });

  it("fails closed for missing, extra, wrong-principal, and duplicate joins", () => {
    expect(() => resolveWorldBindings(plan(), {
      schema: SIMFILE_WORLD_BINDINGS_VERSION,
      bindings: [entry("red")]
    })).toThrow(/cardinality/u);

    const extra = structuredClone(artifact()) as unknown as {
      schema: string;
      bindings: Array<Record<string, unknown>>;
    };
    extra.bindings.push({
      ...entry("red"),
      member: { id: "green", principal_id: "agent:green" },
      capability_manifest_digest: digest("c"),
      token_env: "TINY_FOOTBALL_GREEN_WORLD_TOKEN"
    });
    expect(() => resolveWorldBindings(plan(), extra)).toThrow(/cardinality|join/u);

    const wrong = structuredClone(artifact()) as unknown as { bindings: Array<{ member: { principal_id: string } }> };
    wrong.bindings[0]!.member.principal_id = "agent:blue";
    expect(() => resolveWorldBindings(plan(), wrong)).toThrow(/member identity|duplicate/u);

    const duplicate = structuredClone(artifact()) as unknown as { bindings: Array<{ token_env: string }> };
    duplicate.bindings[1]!.token_env = duplicate.bindings[0]!.token_env;
    expect(() => resolveWorldBindings(plan(), duplicate)).toThrow(/duplicate/u);

    const noAuthority = plan();
    noAuthority.organizationIdentity = undefined;
    expect(() => resolveWorldBindings(noAuthority, artifact())).toThrow(/organization identity/u);
  });

  it("rejects malformed endpoint, env, digest, run, and cross-binding identity metadata", () => {
    const mutate = (change: (value: any) => void): unknown => {
      const value = structuredClone(artifact());
      change(value);
      return value;
    };
    for (const [label, value] of [
      ["json path", mutate((value) => { value.bindings[0].json.url = "http://world/v1/other"; })],
      ["credentials", mutate((value) => { value.bindings[0].json.url = "http://user:pass@world/v1/world"; })],
      ["query", mutate((value) => { value.bindings[0].json.url = "http://world/v1/world?secret=x"; })],
      ["empty query", mutate((value) => { value.bindings[0].json.url = "http://world/v1/world?"; })],
      ["empty fragment", mutate((value) => { value.bindings[0].json.url = "http://world/v1/world#"; })],
      ["noncanonical", mutate((value) => { value.bindings[0].json.url = "HTTP://WORLD/v1/world"; })],
      ["env", mutate((value) => { value.bindings[0].token_env = "actual-secret"; })],
      ["digest", mutate((value) => { value.bindings[0].capability_manifest_digest = digest("A"); })],
      ["run", mutate((value) => { value.bindings[0].run_id = " spaced "; })],
      ["run mismatch", mutate((value) => { value.bindings[0].run_id = "other-run"; })],
      ["world mismatch", mutate((value) => { value.bindings[0].world_instance_id = "other-world"; })]
    ] as Array<[string, unknown]>) {
      expect.soft(() => parseSimfileWorldBindings(value), label).toThrow();
    }
  });

  it("rejects unknown keys, accessors, symbols, proxies, aliases, and sparse arrays", () => {
    expect(() => parseSimfileWorldBindings({ ...artifact(), extra: true })).toThrow(/keys/u);

    const accessor = structuredClone(artifact()) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "schema", { enumerable: true, get: () => SIMFILE_WORLD_BINDINGS_VERSION });
    expect(() => parseSimfileWorldBindings(accessor)).toThrow(/accessor/u);

    const symbol = structuredClone(artifact()) as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol("hidden")] = true;
    expect(() => parseSimfileWorldBindings(symbol)).toThrow(/symbol/u);

    let trapCalls = 0;
    const proxy = new Proxy(structuredClone(artifact()), {
      ownKeys(target) { trapCalls += 1; return Reflect.ownKeys(target); }
    });
    expect(() => parseSimfileWorldBindings(proxy)).toThrow(/proxy/u);
    expect(trapCalls).toBe(0);

    const aliased = structuredClone(artifact()) as unknown as { bindings: unknown[] };
    aliased.bindings[1] = aliased.bindings[0];
    expect(() => parseSimfileWorldBindings(aliased)).toThrow(/aliases/u);

    const sparse = structuredClone(artifact()) as unknown as { bindings: unknown[] };
    sparse.bindings.length = 3;
    expect(() => parseSimfileWorldBindings(sparse)).toThrow(/array contains extended properties/u);
  });
});
