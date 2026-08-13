import { describe, expect, it } from "vitest";

import {
  SIMFILE_WORLD_BINDINGS_VERSION,
  findWorldBindingForNode,
  parseSimfileWorldBindings,
  type SimfileWorldBindingV1
} from "./worldBindings.js";

const binding = (): SimfileWorldBindingV1 => ({
  capability_manifest_digest: `sha256:${"a".repeat(64)}`,
  json: { auth: "bearer", url: "https://world.example/v1/world" },
  mcp: {
    auth: "bearer",
    transport: "streamable_http",
    url: "https://world.example/mcp"
  },
  member: { id: "alpha", principal_id: "agent:alpha" },
  run_id: "run-one",
  token_env: "ALPHA_WORLD_TOKEN",
  world_instance_id: "world-one"
});

const artifact = (bindings: unknown = [binding()]): unknown => ({
  bindings,
  schema: SIMFILE_WORLD_BINDINGS_VERSION
});

describe("world binding hostile-input validation", () => {
  it("rejects excessive depth, node count, properties, and array cardinality", () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 18; index += 1) deep = { child: deep };
    expect(() => parseSimfileWorldBindings(deep)).toThrow(/depth/);

    const leaves = (): Record<string, unknown> => Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`n${index}`, { child: {} }])
    );
    const wide = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`n${index}`, leaves()])
    );
    expect(() => parseSimfileWorldBindings(wide)).toThrow(/node count/);

    const tooManyProperties = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`p${index}`, null])
    );
    expect(() => parseSimfileWorldBindings(tooManyProperties)).toThrow(/property count/);
    expect(() => parseSimfileWorldBindings(artifact(Array.from({ length: 129 }, binding))))
      .toThrow(/cardinality/);
  });

  it("rejects noncanonical and accessor arrays before parsing fields", () => {
    const inherited: unknown[] = [];
    Object.setPrototypeOf(inherited, Object.create(Array.prototype));
    expect(() => parseSimfileWorldBindings(artifact(inherited))).toThrow(/array prototype/);

    const accessor = [binding()];
    Object.defineProperty(accessor, "0", {
      configurable: true,
      enumerable: true,
      get: () => binding()
    });
    expect(() => parseSimfileWorldBindings(artifact(accessor))).toThrow(/accessor array/);
    expect(() => parseSimfileWorldBindings([])).toThrow(/plain object/);
    expect(() => parseSimfileWorldBindings(artifact({}))).toThrow(/plain array/);
  });

  it("rejects endpoint, identity, authentication, schema, and cardinality drift", () => {
    const expectBindingFailure = (mutate: (value: Record<string, unknown>) => void, pattern: RegExp) => {
      const value = structuredClone(binding()) as unknown as Record<string, unknown>;
      mutate(value);
      expect(() => parseSimfileWorldBindings(artifact([value]))).toThrow(pattern);
    };
    expectBindingFailure((value) => {
      (value.json as Record<string, unknown>).url = `https://world.example/${"x".repeat(2_049)}`;
    }, /endpoint is invalid/);
    expectBindingFailure((value) => {
      (value.json as Record<string, unknown>).url = "not a URL";
    }, /endpoint is invalid/);
    expectBindingFailure((value) => {
      (value.json as Record<string, unknown>).url = "ftp://world.example/v1/world";
    }, /canonical credential-free/);
    expectBindingFailure((value) => {
      (value.member as Record<string, unknown>).id = 7;
    }, /member identity/);
    expectBindingFailure((value) => {
      (value.mcp as Record<string, unknown>).auth = "none";
    }, /authentication/);
    expect(() => parseSimfileWorldBindings({
      bindings: [binding()],
      schema: "simfile.world-bindings.invalid"
    })).toThrow(/schema/);
    expect(() => parseSimfileWorldBindings(artifact([]))).toThrow(/1 to 128/);
  });

  it("rejects duplicate node assignments at the read boundary", () => {
    const value = binding();
    expect(() => findWorldBindingForNode({
      artifact: { bindings: [value], schema: SIMFILE_WORLD_BINDINGS_VERSION },
      assignments: [
        { binding: value, nodeId: "agent:alpha" },
        { binding: value, nodeId: "agent:alpha" }
      ],
      canonicalBytes: ""
    }, "agent:alpha")).toThrow(/duplicate binding assignments/);
    expect(findWorldBindingForNode(undefined, "agent:alpha")).toBeUndefined();
  });
});
