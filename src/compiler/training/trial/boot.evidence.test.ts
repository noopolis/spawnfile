import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { TrialEvidenceInput } from "./evidence.js";

const HOME = "/var/lib/spawnfile/instances/daimon/runtime-homes/writer";
const state = vi.hoisted(() => ({ root: "", envFile: "" }));
vi.mock("./project.js", () => ({ writeTrialProject: async () => ({ manifestPath: "/nonexistent/Spawnfile", manifestOverrides: new Map() }) }));
vi.mock("../../buildProject.js", () => ({ buildCompiledProject: async () => undefined }));
vi.mock("../../compileProject.js", () => ({
  compileProject: async () => ({ report: { container: {
    runtime_instances: [{ runtime: "daimon", config_path: "/c.json", engine_by_node_id: { "agent:writer": "codex" }, agent_paths: { "agent:writer": { home_path: HOME } } }],
    persistent_mounts: [{ id: "daimon-codex-runtime-home-writer", mount_path: HOME, volume_name: "home" }]
  } } })
}));
vi.mock("../../runProject.js", () => ({
  runDockerContainer: async () => undefined,
  createDockerRunInvocation: async (_compiled: unknown, _image: string, options: { envFilePath: string }) => {
    state.envFile = await (await import("node:fs/promises")).readFile(options.envFilePath, "utf8");
    return { args: [], command: "docker", envFilePath: "/nonexistent", supportDirectory: path.join(state.root, "support") };
  }
}));
vi.mock("../../runProjectLifecycle.js", () => ({ executeDockerRunWithSupportCleanup: async () => undefined }));

const { prepareTrial } = await import("./boot.js");

beforeEach(async () => { state.root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-boot-evidence-")); });
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

/** One trial whose Docker calls and evidence capture land in one ordered list. */
const trial = async (trialId: string, inspect = "true 0", control?: unknown) => {
  const order: string[] = [];
  const captured: TrialEvidenceInput[] = [];
  const docker = async (args: readonly string[]): Promise<string> => {
    order.push(args.slice(0, 2).join(" "));
    return args[0] === "inspect" ? inspect : "";
  };
  const prepared = await prepareTrial({ agentManifestPath: "/nonexistent/Spawnfile", directory: path.join(state.root, trialId), docker, instructions: "i", trialId,
    control: (control ?? (async () => ({ status: 200, body: "{}" }))) as never,
    evidence: async (input) => { order.push("evidence"); captured.push(input); return { version: "spawnfile.training.trial-evidence.v1", container: input.container, capturedAt: "", captures: [], refused: [] }; } });
  const evidenceDirectory = path.join(state.root, "evidence", trialId);
  return { captured, evidenceDirectory, order, prepared };
};
const gateway = { key: "gateway-key-0123456789abcdef", network: "run-net", url: "http://gateway:43200" };

it("saves the container's evidence after it stops and before the container or any volume is removed", async () => {
  const { captured, evidenceDirectory, order, prepared } = await trial("done");
  const booted = await prepared.boot(gateway, { evidenceDirectory, readyTimeoutMs: 1_000 });
  await booted.teardown();
  const teardown = order.slice(order.indexOf("stop --time"));
  expect(teardown).toEqual(["stop --time", "evidence", "rm -f", "volume rm"]);
  expect(captured).toHaveLength(1);
  const token = /SPAWNFILE_DAIMON_CONTROL_TOKEN=(\S+)/u.exec(state.envFile)![1]!;
  // Every secret the container was given is masked, and no declared engine path may reach its login file.
  expect(captured[0]).toMatchObject({ container: booted.container, directory: evidenceDirectory, secrets: [token, gateway.key],
    diagnostics: [{ agentId: "agent:writer", home: HOME }], loginPaths: [`${HOME}/.codex/auth.json`] });
});

it("saves the evidence of an organization that never became ready, then reports the boot failure", async () => {
  const { captured, evidenceDirectory, order, prepared } = await trial("crashed", "false 1");
  await expect(prepared.boot(null, { evidenceDirectory, readyTimeoutMs: 1_000 })).rejects.toThrow("trial organization exited before readiness");
  expect(order.slice(order.indexOf("stop --time"))).toEqual(["stop --time", "evidence", "rm -f", "volume rm"]);
  expect(captured[0]).toMatchObject({ directory: evidenceDirectory });
});

it("names the failed execution behind a wake still open at the trial's deadline, with the container's secrets masked", async () => {
  let token = "";
  const control = async (target: { token: string }, method: string, route: string) => {
    token = target.token;
    if (method === "POST" && route === "/v2/wakes") return { status: 202, body: JSON.stringify({ state: "accepted", acceptance_id: "a-1" }) };
    if (route.startsWith("/v2/wake-receipts/")) return { status: 200, body: JSON.stringify({ state: "running", execution_id: "e-2" }) };
    if (route === "/v2/availability") return { status: 200, body: JSON.stringify({ agents: [{ agent_id: "agent:writer",
      error: `engine_failed: CLI engine exited with code 1: fatal: stream closed ${target.token}` }] }) };
    return { status: 200, body: JSON.stringify({ executions: [] }) };
  };
  const { captured, evidenceDirectory, prepared } = await trial("open", "true 0", control);
  const booted = await prepared.boot(null, { evidenceDirectory, readyTimeoutMs: 1_000 });
  const wake = await booted.wake("go", { deliveryId: "d-1", timeoutMs: 1_500 });
  expect(wake.state).toBe("timeout");
  expect(wake.failure).toBe(`engine_failed: CLI engine exited with code 1: fatal: stream closed ${"*".repeat(token.length)}`);
  // A turn the trial's deadline cut short returns nothing: teardown still reads and keeps the runtime's failure.
  const masked = `engine_failed: CLI engine exited with code 1: fatal: stream closed ${"*".repeat(token.length)}`;
  expect(await booted.teardown()).toBe(masked);
  expect(captured[0]!.notes).toEqual({ "runtime-failure.txt": masked });
}, 20_000);
