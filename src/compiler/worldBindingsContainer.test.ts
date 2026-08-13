import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WORLD_BINDINGS_IMAGE_PATH } from "../distribution/index.js";
import { piAdapter } from "../runtime/pi/adapter.js";
import { createPiTestNode } from "../runtime/pi/testHelpers.js";

import { createContainerArtifacts } from "./containerArtifacts.js";
import type { CompiledNodeArtifact } from "./containerArtifactsTypes.js";
import type { CompilePlan, ResolvedAgentNode, ResolvedTeamNode } from "./types.js";
import {
  resolveWorldBindings,
  SIMFILE_WORLD_BINDINGS_VERSION,
  WORLD_BINDINGS_OUTPUT_FILE
} from "./worldBindings.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const createFixture = async (
  redOverrides: Partial<ResolvedAgentNode> = {},
  redTokenEnv = "RED_WORLD_TOKEN",
  blueTokenEnv = "BLUE_WORLD_TOKEN"
): Promise<{
  compiled: CompiledNodeArtifact[];
  plan: CompilePlan;
  resolved: ReturnType<typeof resolveWorldBindings>;
}> => {
  const root = "/org/Spawnfile";
  const redSource = "/org/red/Spawnfile";
  const blueSource = "/org/blue/Spawnfile";
  const red = createPiTestNode({
    name: "red",
    runtime: { name: "pi", options: { engine: "pi" } },
    source: redSource,
    ...redOverrides
  });
  const blue = createPiTestNode({
    name: "blue",
    runtime: { name: "pi", options: { engine: "codex" } },
    source: blueSource
  });
  const team: ResolvedTeamNode = {
    description: "",
    docs: [],
    external: [],
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
  const plan: CompilePlan = {
    edges: [
      { from: "team:football", kind: "team_member", label: "red", to: "runtime:red" },
      { from: "team:football", kind: "team_member", label: "blue", to: "runtime:blue" }
    ],
    nodes: [
      { id: "team:football", kind: "team", runtimeName: null, slug: "football", value: team },
      { id: "runtime:red", kind: "agent", runtimeName: "pi", slug: "red", value: red },
      { id: "runtime:blue", kind: "agent", runtimeName: "pi", slug: "blue", value: blue }
    ],
    organizationIdentity: {
      agentMembers: [
        { authoredMemberKey: "blue", kind: "agent", memberId: "blue", principalId: "agent:blue" },
        { authoredMemberKey: "red", kind: "agent", memberId: "red", principalId: "agent:red" }
      ],
      externalParticipants: []
    },
    root,
    runtimes: { pi: { nodeIds: ["runtime:red", "runtime:blue"] } }
  };
  const entries = [
    { member: "red", token_env: redTokenEnv, digest: digest("a") },
    { member: "blue", token_env: blueTokenEnv, digest: digest("b") }
  ].map((entry) => ({
    member: { id: entry.member, principal_id: `agent:${entry.member}` },
    run_id: "run-world-1",
    world_instance_id: "pitch-1",
    capability_manifest_digest: entry.digest,
    token_env: entry.token_env,
    json: { auth: "bearer", url: "http://world:19972/v1/world" },
    mcp: { auth: "bearer", transport: "streamable_http", url: "http://world:19972/mcp" }
  }));
  const [redCompiled, blueCompiled] = await Promise.all([
    piAdapter.compileAgent(red),
    piAdapter.compileAgent(blue)
  ]);
  return {
    compiled: [
      { emittedFiles: [], id: "team:football", kind: "team", runtimeName: null, slug: "football", value: team },
      { emittedFiles: redCompiled.files, id: "runtime:red", kind: "agent", runtimeName: "pi", slug: "red", value: red },
      { emittedFiles: blueCompiled.files, id: "runtime:blue", kind: "agent", runtimeName: "pi", slug: "blue", value: blue }
    ],
    plan,
    resolved: resolveWorldBindings(plan, {
      bindings: entries,
      schema: SIMFILE_WORLD_BINDINGS_VERSION
    })
  };
};

describe("world binding container projection", () => {
  it("retains full evidence while requiring only the native-Pi token env", async () => {
    const fixture = await createFixture();
    const result = await createContainerArtifacts(fixture.plan, fixture.compiled, {
      generatedAt: "2026-07-21T00:00:00.000Z",
      worldBindings: fixture.resolved
    });
    const bindingFile = result.files.find((file) => file.path === WORLD_BINDINGS_OUTPUT_FILE);
    const configFile = result.files.find((file) => file.path.endsWith("/pi-app.json"));
    const dockerfile = result.files.find((file) => file.path === "Dockerfile")?.content ?? "";
    const envExample = result.files.find((file) => file.path === ".env.example")?.content ?? "";
    const config = JSON.parse(configFile?.content ?? "{}") as { agents: Array<Record<string, unknown>> };

    expect(bindingFile).toEqual({
      content: fixture.resolved.canonicalBytes,
      mode: 0o600,
      path: WORLD_BINDINGS_OUTPUT_FILE
    });
    expect(bindingFile?.content).toContain('"mcp"');
    expect(bindingFile?.content).toContain('"capability_manifest_digest"');
    expect(dockerfile).toContain(`COPY ${WORLD_BINDINGS_OUTPUT_FILE} ${WORLD_BINDINGS_IMAGE_PATH}`);
    expect(dockerfile).toContain(
      `RUN chmod 600 ${WORLD_BINDINGS_IMAGE_PATH} && chown spawnfile:spawnfile ${WORLD_BINDINGS_IMAGE_PATH}`
    );
    expect(dockerfile).not.toContain(`chown root:root ${WORLD_BINDINGS_IMAGE_PATH}`);
    expect(result.distribution.report.world_bindings).toEqual({
      artifact_path: WORLD_BINDINGS_IMAGE_PATH,
      digest: `sha256:${createHash("sha256").update(fixture.resolved.canonicalBytes).digest("hex")}`,
      schema: SIMFILE_WORLD_BINDINGS_VERSION
    });
    expect(config.agents.find((agent) => agent.id === "runtime:red")?.world).toEqual({
      tokenEnv: "RED_WORLD_TOKEN",
      url: "http://world:19972/v1/world"
    });
    expect(config.agents.find((agent) => agent.id === "runtime:blue")).not.toHaveProperty("world");
    expect(result.report.runtime_secrets_required).toContain("RED_WORLD_TOKEN");
    expect(result.report.runtime_secrets_required).not.toContain("BLUE_WORLD_TOKEN");
    expect(envExample).toContain("RED_WORLD_TOKEN=");
    expect(envExample).not.toContain("BLUE_WORLD_TOKEN=");

    const standalone = await createContainerArtifacts(fixture.plan, fixture.compiled, {
      generatedAt: "2026-07-21T00:00:00.000Z"
    });
    expect(standalone.files.some((file) => file.path === WORLD_BINDINGS_OUTPUT_FILE)).toBe(false);
    expect(standalone.distribution.report).not.toHaveProperty("world_bindings");
    expect(standalone.distribution.fingerprint).not.toBe(result.distribution.fingerprint);
  });

  it("rejects every binding collision without requiring retained CLI token envs", async () => {
    const projectCollision = await createFixture({
      secrets: [{ name: "RED_WORLD_TOKEN", required: true }]
    });
    await expect(createContainerArtifacts(
      projectCollision.plan,
      projectCollision.compiled,
      { worldBindings: projectCollision.resolved }
    )).rejects.toThrow(/conflicts with an existing environment authority/u);

    const retainedCliCollision = await createFixture(
      { secrets: [{ name: "OPENAI_API_KEY", required: true }] },
      "RED_WORLD_TOKEN",
      "OPENAI_API_KEY"
    );
    await expect(createContainerArtifacts(
      retainedCliCollision.plan,
      retainedCliCollision.compiled,
      { worldBindings: retainedCliCollision.resolved }
    )).rejects.toThrow(/conflicts with an existing environment authority/u);

    const previous = process.env.NOOPOLIS_RUN_ID;
    process.env.NOOPOLIS_RUN_ID = "run-world-1";
    try {
      const recipeCollision = await createFixture(
        {},
        "RED_WORLD_TOKEN",
        "NOOPOLIS_RUN_ID"
      );
      await expect(createContainerArtifacts(
        recipeCollision.plan,
        recipeCollision.compiled,
        { worldBindings: recipeCollision.resolved }
      )).rejects.toThrow(/conflicts with an existing environment authority/u);
    } finally {
      if (previous === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = previous;
    }

    const moltnetCollision = await createFixture(
      {},
      "RED_WORLD_TOKEN",
      "MOLTNET_BLUE_TOKEN"
    );
    await expect(createContainerArtifacts(
      moltnetCollision.plan,
      moltnetCollision.compiled,
      {
        moltnet: {
          files: [],
          nodePlans: [],
          persistentMounts: [],
          ports: [],
          publishedPorts: [],
          serverPlans: [{
            baseUrl: "http://127.0.0.1:8787",
            configPath: "/var/lib/spawnfile/moltnet/servers/pitch/Moltnet.json",
            id: "pitch",
            mode: "managed",
            name: "Pitch",
            networkId: "pitch",
            port: 8787,
            rooms: [],
            secretPatches: [{ envName: "MOLTNET_BLUE_TOKEN", jsonPath: "auth.tokens.0.value" }],
            server: {
              auth: {
                client: { token_id: "blue" },
                mode: "bearer",
                tokens: [{
                  agents: ["blue"],
                  id: "blue",
                  scopes: ["attach", "write"],
                  secret: "MOLTNET_BLUE_TOKEN"
                }]
              },
              listen: { bind: "127.0.0.1", port: 8787 },
              mode: "managed",
              store: { kind: "memory" }
            },
            teamSource: "/org/Spawnfile"
          }]
        },
        worldBindings: moltnetCollision.resolved
      }
    )).rejects.toThrow(/conflicts with an existing environment authority/u);
  });
});
