import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseSimfileWorldBindings,
  SIMFILE_WORLD_BINDINGS_VERSION,
  type SimfileWorldBindingV1
} from "../../compiler/worldBindings.js";
import { piAdapter } from "./adapter.js";
import { createPiAgentConfig } from "./appTemplate.js";
import { createPiTestNode } from "./testHelpers.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const members = ["alpha", "beta", "delta", "gamma"] as const;
const tokenEnv = (member: (typeof members)[number]): string =>
  `${member.replace("-", "_").toUpperCase()}_WORLD_TOKEN`;
const bindings = (): readonly SimfileWorldBindingV1[] => parseSimfileWorldBindings({
  schema: SIMFILE_WORLD_BINDINGS_VERSION,
  bindings: members.map((member, index) => ({
    member: { id: member, principal_id: `agent:${member}` },
    run_id: "run-1",
    world_instance_id: "environment-1",
    capability_manifest_digest: digest(String.fromCharCode(97 + index)),
    token_env: tokenEnv(member),
    json: { auth: "bearer", url: "http://simfile-world:19972/v1/world" },
    mcp: { auth: "bearer", transport: "streamable_http", url: "http://simfile-world:19972/mcp" }
  }))
}).bindings;

const emitted = (targets: Awaited<ReturnType<NonNullable<typeof piAdapter.createContainerTargets>>>) => {
  const target = targets[0];
  if (!target) throw new Error("expected Pi target");
  const config = target.files.find((file) => file.path === "pi-app.json")?.content;
  const app = target.files.find((file) => file.path === "runtime/app.mjs")?.content;
  if (!config || !app) throw new Error("expected Pi app artifacts");
  return { app, config, target };
};

describe("Pi world binding projection", () => {
  it("gives all four Pi agents only their own JSON endpoint and env identity", async () => {
    const resolved = bindings();
    const nodes = members.map((member) => createPiTestNode({
      name: member,
      runtime: { name: "pi", options: { engine: "pi" } },
      source: `/org/${member}/Spawnfile`
    }));
    const canaries = new Map(members.map((member, index) => [
      tokenEnv(member),
      `secret-world-bearer-value-${index}`
    ]));
    for (const [env, canary] of canaries) process.env[env] = canary;
    try {
      const result = emitted(await piAdapter.createContainerTargets!(nodes.map((node, index) => ({
        emittedFiles: [], id: `runtime:${members[index]}`, kind: "agent" as const,
        slug: members[index]!, value: node,
        worldBinding: resolved[index]!
      }))));
      const config = JSON.parse(result.config) as { agents: Array<Record<string, unknown>> };
      expect(config.agents).toHaveLength(4);
      for (const member of members) {
        const agent = config.agents.find((candidate) => candidate.id === `runtime:${member}`);
        expect(agent?.world).toEqual({
          url: "http://simfile-world:19972/v1/world",
          tokenEnv: tokenEnv(member)
        });
        for (const other of members.filter((candidate) => candidate !== member)) {
          expect(JSON.stringify(agent)).not.toContain(tokenEnv(other));
        }
      }
      expect(result.config).not.toContain("/mcp");
      expect(result.config).not.toContain("capability_manifest_digest");
      for (const canary of canaries.values()) {
        expect(result.config).not.toContain(canary);
        expect(result.app).not.toContain(canary);
      }
      expect(result.app).toContain("world: config.world");
    } finally {
      for (const env of canaries.keys()) delete process.env[env];
    }
  });

  it("keeps no-world config free of bindings and pins the generated app bytes", async () => {
    const node = createPiTestNode({ name: "standalone" });
    const result = emitted(await piAdapter.createContainerTargets!([
      { emittedFiles: [], id: "agent:standalone", kind: "agent", slug: "standalone", value: node }
    ]));
    const config = JSON.parse(result.config) as { agents: Array<Record<string, unknown>> };
    expect(config.agents[0]).not.toHaveProperty("world");
    expect(result.target).not.toHaveProperty("worldTokenEnvNames");
    expect(result.app).not.toContain("world: config.world");
    expect(Buffer.byteLength(result.app)).toBe(71_411);
    expect(createHash("sha256").update(result.app).digest("hex"))
      .toBe("f69411a72e2f35c9962af639990d949f20847001aed827f7358368c46c48db82");
  });

  it("does not claim Pi-native JSON tools for a CLI engine binding", () => {
    const alphaBinding = bindings().find((binding) => binding.member.id === "alpha");
    if (!alphaBinding) throw new Error("expected alpha binding");
    const node = createPiTestNode({ runtime: { name: "pi", options: { engine: "codex" } } });
    expect(createPiAgentConfig(node, "alpha", "runtime:alpha", alphaBinding)).not.toHaveProperty("world");
  });
});
