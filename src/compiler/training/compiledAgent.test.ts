import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { resolveCompiledAgent } from "./index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compiled-agent-")); roots.push(root);
  const report = { spawnfile_version: "0.1", nodes: [{ id: "agent:reader", kind: "agent" }], container: {
    runtime_instances: [{ id: "shared", runtime: "daimon", node_ids: ["agent:reader", "agent:other"],
      config_path: "/custom/runtime.json", workspace_path: "/custom/workspaces", home_path: null,
      agent_paths: { "agent:reader": { workspace_path: "/custom/reader", home_path: "/custom/home",
        skill_roots: ["/custom/reader/.agents/skills", "/custom/reader/.codex/skills"] } } }],
    moltnet: { node_plans: [{ node_id: "agent:reader", member_id: "alias", network_id: "network", config_path: "/net/node.json" },
      { node_id: "agent:other", member_id: "other", network_id: "network", config_path: "/net/other.json" }],
      server_plans: [{ network_id: "network", mode: "managed", config_path: "/net/server.json" }] }
  } };
  const save = () => writeFile(path.join(root, "spawnfile-report.json"), JSON.stringify(report));
  await save(); return { root, report, save };
};
it("creates fixtures under the configured temporary directory", async () => {
  const configured = await mkdtemp(path.join(os.tmpdir(), "configured-temp-")); roots.push(configured);
  const temporaryDirectory = vi.spyOn(os, "tmpdir").mockReturnValue(configured);
  try {
    const { root } = await fixture();
    expect(path.dirname(root)).toBe(configured);
  } finally { temporaryDirectory.mockRestore(); }
});
it("resolves report-owned paths and attachments by node identity through the public export", async () => {
  const { root } = await fixture();
  const value = await resolveCompiledAgent(root, "reader");
  expect(value).toMatchObject({ agentId: "agent:reader", runtime: "daimon", instanceId: "shared",
    workspace: `${root}/container/rootfs/custom/reader`, home: `${root}/container/rootfs/custom/home`,
    runtimeConfig: `${root}/container/rootfs/custom/runtime.json`,
    skillRoots: [".agents", ".codex"].map(name => `${root}/container/rootfs/custom/reader/${name}/skills`),
    moltnet: [{ networkId: "network", memberId: "alias", nodeConfig: `${root}/container/rootfs/net/node.json`,
      serverConfig: `${root}/container/rootfs/net/server.json` }],
    containerPaths: { workspace: "/custom/reader", home: "/custom/home", runtimeConfig: "/custom/runtime.json" } });
  expect(await resolveCompiledAgent(root, "agent:reader")).toEqual(value);
});
it("supports external servers without inventing a local config", async () => {
  const { root, report, save } = await fixture();
  report.container.moltnet.server_plans = [{ network_id: "network", mode: "external" } as typeof report.container.moltnet.server_plans[number]];
  await save(); expect((await resolveCompiledAgent(root, "reader")).moltnet[0]?.serverConfig).toBeNull();
});
it.each(["openclaw", "picoclaw"])("resolves existing single-agent %s report paths", async runtime => {
  const { root, report, save } = await fixture();
  const instance = report.container.runtime_instances[0]!;
  instance.runtime = runtime; instance.node_ids = ["agent:reader"];
  Reflect.deleteProperty(instance, "agent_paths"); Reflect.deleteProperty(report.container, "moltnet");
  await save(); expect(await resolveCompiledAgent(root, "reader")).toMatchObject({ home: null, moltnet: [],
    skillRoots: [`${root}/container/rootfs/custom/workspaces/skills`] });
});
it.each(["unknown", "wrong version", "missing shared paths", "duplicate instance", "missing server", "relative path", "traversal", "malformed"])("refuses %s", async kind => {
  const { root, report, save } = await fixture();
  if (kind === "wrong version") report.spawnfile_version = "0.2";
  if (kind === "missing shared paths") Reflect.deleteProperty(report.container.runtime_instances[0]!, "agent_paths");
  if (kind === "duplicate instance") report.container.runtime_instances.push(report.container.runtime_instances[0]!);
  if (kind === "missing server") report.container.moltnet.server_plans = [];
  if (kind === "relative path") report.container.runtime_instances[0]!.config_path = "relative.json";
  if (kind === "traversal") report.container.runtime_instances[0]!.config_path = "/../escape.json";
  await save();
  if (kind === "malformed") await writeFile(path.join(root, "spawnfile-report.json"), "{}");
  await expect(resolveCompiledAgent(root, kind === "unknown" ? "absent" : "reader")).rejects.toThrow();
});
it("refuses a missing report", async () => {
  const { root } = await fixture(); await rm(path.join(root, "spawnfile-report.json"));
  await expect(resolveCompiledAgent(root, "reader")).rejects.toThrow(/ENOENT/);
});
