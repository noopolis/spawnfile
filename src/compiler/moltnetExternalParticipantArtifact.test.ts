import { describe, expect, it } from "vitest";
import { createMoltnetExternalParticipantArtifactPath } from "./moltnetArtifactPaths.js";
import {
  buildMoltnetExternalParticipantArtifact,
  createMoltnetExternalParticipantArtifactFiles,
  parseMoltnetExternalParticipantArtifact,
  renderMoltnetExternalParticipantArtifact
} from "./moltnetExternalParticipantArtifact.js";

const input = {
  participant: { authoredParticipantKey: "world", kind: "service" as const, memberId: "world", principalId: "system:world" },
  networkId: "pitch", tokenId: "world", tokenEnv: "TINY_FOOTBALL_WORLD_MOLTNET_TOKEN", directMessagePeers: ["red", "blue"]
};
type Artifact = ReturnType<typeof buildMoltnetExternalParticipantArtifact>;
type MutableArtifact = {
  version: Artifact["version"];
  participant: { authored_key: string; kind: "service"; member_id: string; principal_id: string };
  network: { id: string };
  auth: { mode: "bearer"; token_id: string; token_env: string };
  direct_messages: Array<{ members: [string, string] }>;
};
const mutableArtifact = (value: Artifact): MutableArtifact => structuredClone(value) as MutableArtifact;
describe("Moltnet external participant artifact", () => {
  it("renders the endpoint-free golden bytes", () => {
    const text = renderMoltnetExternalParticipantArtifact(buildMoltnetExternalParticipantArtifact(input));
    expect(text).toBe(`{
  "version": "spawnfile.moltnet-external-participant.v1",
  "participant": {
    "authored_key": "world",
    "kind": "service",
    "member_id": "world",
    "principal_id": "system:world"
  },
  "network": {
    "id": "pitch"
  },
  "auth": {
    "mode": "bearer",
    "token_id": "world",
    "token_env": "TINY_FOOTBALL_WORLD_MOLTNET_TOKEN"
  },
  "direct_messages": [
    {
      "members": [
        "blue",
        "world"
      ]
    },
    {
      "members": [
        "red",
        "world"
      ]
    }
  ]
}
`);
  });
  it("rejects base_url, unknown keys, aliases, and non-canonical ordering", () => {
    const artifact = buildMoltnetExternalParticipantArtifact(input);
    expect(() => parseMoltnetExternalParticipantArtifact({ ...artifact, network: { id: "pitch", base_url: "http://bad" } })).toThrow();
    expect(() => parseMoltnetExternalParticipantArtifact({ ...artifact, extra: true })).toThrow();
    const aliased = { ...artifact, direct_messages: [{ members: ["blue", "world"] as [string, string] }] };
    (aliased.direct_messages as Array<{ members: [string, string] }>).push(aliased.direct_messages[0]);
    expect(() => parseMoltnetExternalParticipantArtifact(aliased)).toThrow();
  });
  it("returns recursively frozen output", () => {
    const parsed = parseMoltnetExternalParticipantArtifact(buildMoltnetExternalParticipantArtifact(input));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.direct_messages[0].members)).toBe(true);
  });

  it("orders by peer even when the external member sorts first", () => {
    const artifact = buildMoltnetExternalParticipantArtifact({
      ...input,
      participant: { ...input.participant, memberId: "a", principalId: "system:a", authoredParticipantKey: "a" },
      directMessagePeers: ["z", "b"]
    });
    expect(artifact.direct_messages.map((entry) => entry.members)).toEqual([["a", "b"], ["a", "z"]]);
    expect(() => parseMoltnetExternalParticipantArtifact({
      ...artifact,
      auth: { ...artifact.auth, token_id: "bad.token" }
    })).toThrow();
  });

  it("rejects non-enumerable and accessor properties", () => {
    const artifact = buildMoltnetExternalParticipantArtifact(input);
    const hidden = { ...artifact } as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => parseMoltnetExternalParticipantArtifact(hidden)).toThrow();
    const accessor = { ...artifact } as Record<string, unknown>;
    Object.defineProperty(accessor, "version", { enumerable: true, get: () => artifact.version });
    expect(() => parseMoltnetExternalParticipantArtifact(accessor)).toThrow();
  });

  it("rejects altered, null, and custom prototypes on every accepted array", () => {
    const artifact = buildMoltnetExternalParticipantArtifact(input);
    for (const prototype of [null, { altered: true }]) {
      const messages = structuredClone(artifact);
      Object.setPrototypeOf(messages.direct_messages, prototype);
      expect(() => parseMoltnetExternalParticipantArtifact(messages)).toThrow(/array prototype/);

      const members = structuredClone(artifact);
      Object.setPrototypeOf(members.direct_messages[0].members, prototype);
      expect(() => parseMoltnetExternalParticipantArtifact(members)).toThrow(/array prototype/);

      const peers = ["red", "blue"];
      Object.setPrototypeOf(peers, prototype);
      expect(() => buildMoltnetExternalParticipantArtifact({ ...input, directMessagePeers: peers })).toThrow(/array prototype/);
    }
    expect(buildMoltnetExternalParticipantArtifact(input).direct_messages).toHaveLength(2);
  });

  it("rejects canonical-looking member ids beyond the 255-byte bound at every admission", () => {
    const oversized = Array.from({ length: 5 }, () => "a".repeat(63)).join(".");
    expect(oversized.length).toBeGreaterThan(255);
    expect.soft(() => createMoltnetExternalParticipantArtifactPath("pitch", oversized)).toThrow();
    expect.soft(() => buildMoltnetExternalParticipantArtifact({
      ...input,
      directMessagePeers: [oversized]
    })).toThrow();

    const parsedInput = mutableArtifact(buildMoltnetExternalParticipantArtifact(input));
    parsedInput.direct_messages[0].members[0] = oversized;
    expect.soft(() => parseMoltnetExternalParticipantArtifact(parsedInput)).toThrow();
  });

  it("rejects root and nested proxies without executing reflection traps", () => {
    const artifact = structuredClone(buildMoltnetExternalParticipantArtifact(input));
    for (const location of ["root", "participant"] as const) {
      let trapCalls = 0;
      const target = location === "root" ? artifact : artifact.participant;
      const proxy = new Proxy(target, {
        getPrototypeOf(value) { trapCalls += 1; return Reflect.getPrototypeOf(value); },
        ownKeys(value) { trapCalls += 1; return Reflect.ownKeys(value); }
      });
      const candidate = location === "root" ? proxy : { ...artifact, participant: proxy };
      expect.soft(() => parseMoltnetExternalParticipantArtifact(candidate), location).toThrow(/proxy/u);
      expect.soft(trapCalls, location).toBe(0);
    }
  });

  it("rejects non-string authored keys without invoking coercion hooks", () => {
    const artifact = mutableArtifact(buildMoltnetExternalParticipantArtifact(input));
    let coercionCalls = 0;
    (artifact.participant as unknown as { authored_key: unknown }).authored_key = {
      toString: () => {
        coercionCalls += 1;
        return "world";
      }
    };

    expect(() => parseMoltnetExternalParticipantArtifact(artifact)).toThrow(/authored key value/u);
    expect(coercionCalls).toBe(0);
  });

  it("rejects sparse, oversized, and accessor arrays before index access", () => {
    const maximumPeers = Array.from({ length: 128 }, (_, index) => `a${String(index).padStart(3, "0")}`);
    expect(buildMoltnetExternalParticipantArtifact({ ...input, directMessagePeers: maximumPeers }).direct_messages)
      .toHaveLength(128);

    const sparse = mutableArtifact(buildMoltnetExternalParticipantArtifact(input));
    sparse.direct_messages.length = 3;
    expect(() => parseMoltnetExternalParticipantArtifact(sparse)).toThrow(/sparse array/u);

    const oversized = mutableArtifact(buildMoltnetExternalParticipantArtifact(input));
    const messages = Array.from({ length: 129 }, (_, index) => ({
      members: [`a${String(index).padStart(3, "0")}`, "world"] as [string, string]
    }));
    oversized.direct_messages = messages;
    expect.soft(() => parseMoltnetExternalParticipantArtifact(oversized)).toThrow(/cardinality|too many/u);

    let indexReads = 0;
    const guarded = mutableArtifact(buildMoltnetExternalParticipantArtifact(input));
    const guardedMessages = new Array(129);
    Object.defineProperty(guardedMessages, "0", {
      enumerable: true,
      get: () => { indexReads += 1; return { members: ["blue", "world"] }; }
    });
    guarded.direct_messages = guardedMessages;
    expect.soft(() => parseMoltnetExternalParticipantArtifact(guarded)).toThrow(/cardinality|too many/u);
    expect.soft(indexReads).toBe(0);

    let builderReads = 0;
    const guardedPeers = new Array(129);
    Object.defineProperty(guardedPeers, "0", {
      enumerable: true,
      get: () => { builderReads += 1; return "blue"; }
    });
    expect.soft(() => buildMoltnetExternalParticipantArtifact({
      ...input,
      directMessagePeers: guardedPeers
    })).toThrow(/cardinality|too many/u);
    expect.soft(builderReads).toBe(0);

    let admittedBuilderReads = 0;
    const guardedAdmittedPeers = new Array(1);
    Object.defineProperty(guardedAdmittedPeers, "0", {
      enumerable: true,
      get: () => { admittedBuilderReads += 1; return "blue"; }
    });
    expect.soft(() => buildMoltnetExternalParticipantArtifact({
      ...input,
      directMessagePeers: guardedAdmittedPeers
    })).toThrow(/accessor/u);
    expect.soft(admittedBuilderReads).toBe(0);
  });

  it("bounds hostile unknown-object traversal by depth and node count", () => {
    const deep = structuredClone(buildMoltnetExternalParticipantArtifact(input)) as unknown as Record<string, unknown>;
    let cursor: Record<string, unknown> = {};
    deep.unknown = cursor;
    for (let index = 0; index < 17; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => parseMoltnetExternalParticipantArtifact(deep)).toThrow(/depth exceeds/u);

    const wide = structuredClone(buildMoltnetExternalParticipantArtifact(input)) as unknown as Record<string, unknown>;
    wide.unknown = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`k${index}`, {}]));
    expect(() => parseMoltnetExternalParticipantArtifact(wide)).toThrow(/property count|node count/u);
  });

  it("rejects symbols, custom objects, array extensions, cycles, and key reordering", () => {
    const valid = buildMoltnetExternalParticipantArtifact(input);
    expect(() => parseMoltnetExternalParticipantArtifact(valid)).not.toThrow();

    const symbol = structuredClone(valid) as typeof valid & { [key: symbol]: unknown };
    symbol[Symbol("hidden")] = true;
    expect(() => parseMoltnetExternalParticipantArtifact(symbol)).toThrow(/symbol/u);
    const inherited = structuredClone(valid);
    Object.setPrototypeOf(inherited.network, { inherited: true });
    expect(() => parseMoltnetExternalParticipantArtifact(inherited)).toThrow(/object prototype/u);
    const extended = structuredClone(valid);
    (extended.direct_messages as unknown as { extra: boolean }).extra = true;
    expect(() => parseMoltnetExternalParticipantArtifact(extended)).toThrow(/extended array/u);
    const cycle = structuredClone(valid) as unknown as Record<string, unknown>;
    (cycle.network as Record<string, unknown>).cycle = cycle;
    expect(() => parseMoltnetExternalParticipantArtifact(cycle)).toThrow(/alias or cycle/u);
    const reordered = {
      participant: valid.participant,
      version: valid.version,
      network: valid.network,
      auth: valid.auth,
      direct_messages: valid.direct_messages
    };
    expect(() => parseMoltnetExternalParticipantArtifact(reordered)).toThrow(/keys must/u);
  });

  it("rejects malformed identities, tuples, ordering, and exact bounds", () => {
    const valid = buildMoltnetExternalParticipantArtifact(input);
    const cases: Array<[string, (value: MutableArtifact) => void]> = [
      ["principal", (value) => { value.participant.principal_id = "agent:world"; }],
      ["authored key", (value) => { value.participant.authored_key = "other"; }],
      ["network", (value) => { value.network.id = "Pitch"; }],
      ["token", (value) => { value.auth.token_id = "bad.token"; }],
      ["env grammar", (value) => { value.auth.token_env = "actual-secret"; }],
      ["env length", (value) => { value.auth.token_env = `A${"B".repeat(128)}`; }],
      ["missing external", (value) => { value.direct_messages[0].members = ["blue", "red"]; }],
      ["duplicate external", (value) => { value.direct_messages[0].members = ["world", "world"]; }],
      ["tuple ordering", (value) => { value.direct_messages[0].members = ["world", "blue"]; }],
      ["peer ordering", (value) => { value.direct_messages.reverse(); }]
    ];
    for (const [label, mutate] of cases) {
      const value = mutableArtifact(valid);
      mutate(value);
      expect.soft(() => parseMoltnetExternalParticipantArtifact(value), label).toThrow();
    }
    expect(() => buildMoltnetExternalParticipantArtifact({ ...input, directMessagePeers: [] })).toThrow();
    expect(() => buildMoltnetExternalParticipantArtifact({ ...input, directMessagePeers: ["red", "red"] })).toThrow();
    expect(() => buildMoltnetExternalParticipantArtifact({ ...input, directMessagePeers: ["world"] })).toThrow();
    expect(() => buildMoltnetExternalParticipantArtifact({ ...input, tokenEnv: "not-an-env" })).toThrow();
    expect(() => createMoltnetExternalParticipantArtifactPath("Pitch", "world")).toThrow();
    expect(() => createMoltnetExternalParticipantArtifactPath("pitch", "a.b.c.d.e.f.g.h.i")).toThrow();
  });

  it("sorts one secret-free file per network and participant and rejects duplicates", () => {
    const intent = (networkId: string, memberId: string) => ({
      ...input,
      networkId,
      participant: { authoredParticipantKey: memberId, kind: "service" as const, memberId, principalId: `system:${memberId}` }
    });
    const emitted = createMoltnetExternalParticipantArtifactFiles([
      intent("zeta", "world"), intent("alpha", "zebra")
    ]);
    expect(emitted.files.map((file) => file.path)).toEqual([
      "moltnet/external-participants/alpha/zebra.json",
      "moltnet/external-participants/zeta/world.json"
    ]);
    expect(emitted.files.every((file) => !file.path.startsWith("container/rootfs/"))).toBe(true);
    expect(emitted.files.every((file) => file.mode === 0o600)).toBe(true);
    expect(emitted.artifacts).toHaveLength(2);
    expect(() => createMoltnetExternalParticipantArtifactFiles([intent("pitch", "world"), intent("pitch", "world")]))
      .toThrow(/duplicate external participant artifact/u);

    const canary = "actual-world-token-value-DO-NOT-EMIT";
    const previous = process.env.WORLD_TOKEN_ENV;
    process.env.WORLD_TOKEN_ENV = canary;
    try {
      const text = renderMoltnetExternalParticipantArtifact(buildMoltnetExternalParticipantArtifact({ ...input, tokenEnv: "WORLD_TOKEN_ENV" }));
      expect(text).toContain('"token_env": "WORLD_TOKEN_ENV"');
      expect(text).not.toContain(canary);
      const hostile = mutableArtifact(buildMoltnetExternalParticipantArtifact({ ...input, tokenEnv: "WORLD_TOKEN_ENV" }));
      hostile.auth.token_env = canary;
      let errorText = "";
      try { parseMoltnetExternalParticipantArtifact(hostile); } catch (error) { errorText = String(error); }
      expect(errorText).toMatch(/invalid Moltnet external participant artifact/u);
      expect(errorText).not.toContain(canary);
    } finally {
      if (previous === undefined) delete process.env.WORLD_TOKEN_ENV;
      else process.env.WORLD_TOKEN_ENV = previous;
    }
  });
});
