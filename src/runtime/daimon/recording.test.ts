import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { resolveTargetResources } from "../../compiler/containerTargetResources.js";
import { resolveInstancePaths } from "../../compiler/containerTargetPlanResolution.js";
import { resolveDaimonUidEntrypointOwnershipPlan } from "../../compiler/containerDaimonUidEntrypointRender.js";
import type { RuntimeTargetPlan } from "../../compiler/containerArtifactsTypes.js";
import type { ResolvedWorkspaceResource } from "../../compiler/workspaceResources.js";
import type { ResolvedAgentNode } from "../../compiler/types.js";
import type { ContainerTargetInput } from "../types.js";
import { createPiTestNode } from "../pi/testHelpers.js";
import { daimonAdapter } from "./adapter.js";
import { createDaimonContainerTargets, DAIMON_CONFIG_FILE } from "./config.js";
import { assertDaimonRecordingIsolation, daimonRecordingDirectory } from "./recording.js";

const resource = (id: string, sharing: "per_agent" | "team" = "per_agent"): ResolvedWorkspaceResource => ({
  id, sharing, kind: "volume", mode: "mutable", mount: `./${id}`,
  scope: { kind: "team", key: "/tmp/org/Spawnfile", name: "org" }
});
const input = (slug = "writer", overrides: Partial<ResolvedAgentNode> = {}): ContainerTargetInput & { value: ResolvedAgentNode } => ({
  emittedFiles: [], id: `agent:${slug}`, kind: "agent", slug,
  value: createPiTestNode({ name: "Writer", runtime: { name: "daimon", options: { engine: "codex" } },
    source: "/tmp/writer/Spawnfile", ...overrides })
});
const recording = (volumes: string[] = [], keep?: string) => ({ record: { volumes, ...(keep ? { keep } : {}) }, graders: {}, targets: [] });
const configFrom = (files: Array<{ path: string; content: string }>) => JSON.parse(files.find((file) => file.path === DAIMON_CONFIG_FILE)!.content);

describe("Daimon wake recording config", () => {
  it("preserves the complete pre-recording target bytes when recording is off", async () => {
    const targets = await createDaimonContainerTargets([input()]);
    // Preserve the pre-recording payload; additive report-only paths are tested in config.test.ts.
    const payload = targets.map(({ agentPathsByNodeId: _paths, ...target }) => target);
    expect(createHash("sha256").update(JSON.stringify(payload)).digest("hex"))
      .toBe("0124c7411d4afb164e4a95627493bc9b3d0ba0be21094ba95443c8fdbecd9465");
    expect(configFrom(targets[0]!.files).agents[0]).not.toHaveProperty("recording");
    expect(targets[0]!.persistentMounts!.some((mount) => mount.id.startsWith("daimon-recording-"))).toBe(false);
  });

  it.each([1, 2])("uses exact sorted per-agent and team backing paths for %s agents", async (count) => {
    const inputs = [input("writer", { workspaceResources: [resource("zeta"), resource("shared", "team")], training: recording(["zeta", "shared"], "2h") }),
      ...(count === 2 ? [input("peer", { workspaceResources: [resource("shared", "team")], training: recording(["shared"]) })] : [])];
    const target = (await createDaimonContainerTargets(inputs))[0]!;
    const instancePaths = resolveInstancePaths("daimon", target.id, daimonAdapter.container);
    const resources = resolveTargetResources(target, inputs, instancePaths, daimonAdapter.container, "/tmp/org/Spawnfile");
    const emitted = configFrom(target.files).agents.find((agent: { id: string }) => agent.id === "agent:writer");
    expect(emitted.recording).toEqual({ directory: "/var/lib/spawnfile/recording/writer", keepMs: 7_200_000,
      snapshots: ["shared", "zeta"].map((id) => ({ id, path: resources.find((entry) => entry.id === id)!.backingPath })) });
    expect(emitted.recording.snapshots[0].path).toMatch(/^\/var\/lib\/spawnfile\/resources\/teams\//u);
    expect(emitted.recording.snapshots[1].path).toMatch(/^\/var\/lib\/spawnfile\/resources\/instances\//u);
    expect(target.persistentMounts).toContainEqual({ id: "daimon-recording-writer", lifecycle: "exclusive-reattach",
      mountPath: "/var/lib/spawnfile/recording/writer", reason: "Daimon wake recording for agent:writer" });
    if (count === 2) expect(configFrom(target.files).agents.find((agent: { id: string }) => agent.id === "agent:peer").recording.keepMs).toBe(30 * 86_400_000);
  });

  it("prepares the recording mount through the existing runtime-user 0700 ownership path", async () => {
    const target = (await createDaimonContainerTargets([input("writer", { training: recording() })]))[0]!;
    const instancePaths = resolveInstancePaths("daimon", target.id, daimonAdapter.container);
    const plan: RuntimeTargetPlan = { id: target.id, envFiles: [], instancePaths, meta: daimonAdapter.container,
      modelAuthMethods: {}, modelSecretsRequired: [], runtimeName: "daimon", runtimeRoot: "/opt/spawnfile/runtime-installs/daimon",
      persistentMounts: target.persistentMounts!.map((mount) => ({ id: mount.id, reason: mount.reason, volume_name: mount.id,
        mount_path: mount.mountPath.replaceAll("<instance-root>", instancePaths.instanceRoot) })),
      targetFiles: target.files, engineByNodeId: target.engineByNodeId };
    const ownership = resolveDaimonUidEntrypointOwnershipPlan([plan], target.persistentMounts!.map((mount) =>
      mount.mountPath.replaceAll("<instance-root>", instancePaths.instanceRoot)));
    expect(ownership.stateRoots).toContain("/var/lib/spawnfile/recording/writer");
    expect(ownership.privateDirectories).toContain("/var/lib/spawnfile/recording/writer");
    expect(ownership.privateModeDirectories).toContain("/var/lib/spawnfile/recording/writer");
  });

  it("leaves non-recording peers unchanged", async () => {
    const targets = await createDaimonContainerTargets([input("writer", { training: recording() }), input("peer")]);
    const agents = configFrom(targets[0]!.files).agents;
    expect(agents.find((agent: { id: string }) => agent.id === "agent:peer")).not.toHaveProperty("recording");
    expect(agents.find((agent: { id: string }) => agent.id === "agent:writer").recording).toEqual({
      directory: "/var/lib/spawnfile/recording/writer", keepMs: 2_592_000_000, snapshots: []
    });
  });

  it("reuses training's unknown, non-volume, ambiguous, and fed resource checks", async () => {
    const fed = { ...resource("feed"), feed: { source: { kind: "directory", path: "/tmp/feed" } } } as unknown as ResolvedWorkspaceResource;
    const git = { ...resource("git"), kind: "git", url: "https://example.invalid/repo" } as ResolvedWorkspaceResource;
    for (const [resources, id, message] of [
      [[], "missing", /unknown id missing/u], [[git], "git", /must be a volume/u],
      [[fed], "feed", /fed volume feed is recorded through its landing log/u],
      [[resource("twice"), resource("twice")], "twice", /ambiguous id twice/u]
    ] as const) await expect(createDaimonContainerTargets([input("writer", {
      workspaceResources: [...resources], training: recording([id])
    })])).rejects.toThrow(message);
  });

  it("honors snapshot bounds and rejects peer-store/root overlap", async () => {
    const resources = Array.from({ length: 17 }, (_, index) => resource(`root-${index}`));
    await expect(createDaimonContainerTargets([input("writer", { workspaceResources: resources,
      training: recording(resources.map((entry) => entry.id)) })])).rejects.toThrow(/at most 16/u);
    await expect(createDaimonContainerTargets([input("writer", { workspaceResources: [resource("bad/id")],
      training: recording(["bad/id"]) })])).rejects.toThrow(/id or path bounds/u);
    const item = { directory: "/store/a", keepMs: 1, snapshots: [] };
    expect(() => assertDaimonRecordingIsolation([item, { ...item }], "/instances")).toThrow(/overlaps/u);
    expect(() => assertDaimonRecordingIsolation([item], "/store")).toThrow(/overlaps/u);
    expect(() => assertDaimonRecordingIsolation([item, { directory: "/store/b", keepMs: 1,
      snapshots: [{ id: "a", path: "/store/a/root" }] }], "/instances")).toThrow(/overlaps/u);
    expect(() => daimonRecordingDirectory("../escape")).toThrow(/safe agent slug/u);
  });

  it("keeps Daimon's serialized configuration byte limit when recording is present", async () => {
    await expect(createDaimonContainerTargets([input("writer", { training: recording(), mcpServers: [{
      name: "large", transport: "stdio", command: "/bin/true", args: ["a".repeat(1_048_576)], tools: ["large"]
    }] })])).rejects.toThrow(/config exceeds Daimon's public config limit/u);
  });
});
