import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resolveFeedSource } from "../../../volume/index.js";
import { TRAINING_MOMENT_VERSION, type TrainingMoment } from "../moments.js";

const run = promisify(execFile);
const BACKING = "/var/lib/spawnfile/resources/teams/desk/corpus";
const STATE = "/var/lib/spawnfile/resources/teams/desk/state";
const WORKSPACE = "/var/lib/spawnfile/instances/daimon/org/workspace/agents/writer";

const state = vi.hoisted(() => ({
  root: "",
  /** Per booted organization: the volume each resource mount used and what the organization found in it. */
  boots: [] as Array<{ volumes: Record<string, string>; index: string | null; seed: string | null; sentinel: string | null }>,
  pending: [] as Array<Record<string, string>>
}));
vi.mock("./project.js", () => ({ writeTrialProject: async () => ({ manifestPath: "/nonexistent/Spawnfile", manifestOverrides: new Map() }) }));
vi.mock("../../buildProject.js", () => ({ buildCompiledProject: async () => undefined }));
vi.mock("../../compileProject.js", () => ({
  // Every trial compiles the same project, so the compiler hands every trial the same declared team volume names.
  compileProject: async () => ({ report: { container: {
    runtime_instances: [{ runtime: "daimon", config_path: "/c.json", engine_by_node_id: { "agent:writer": "codex" },
      agent_paths: { "agent:writer": { workspace_path: WORKSPACE } } }],
    persistent_mounts: [
      { id: "workspace-resource-corpus", mount_path: BACKING, volume_name: "desk-corpus", declared_volume_name: "desk-corpus" },
      { id: "workspace-resource-state", mount_path: STATE, volume_name: "desk-state", declared_volume_name: "desk-state" }
    ],
    workspace_resources: [
      { id: "research-corpus", kind: "volume", backing_path: BACKING, resolved_identity: `sha256:${"a".repeat(64)}`, volume_name: "desk-corpus" },
      { id: "edition-state", kind: "volume", backing_path: STATE, resolved_identity: `sha256:${"b".repeat(64)}`, volume_name: "desk-state" }
    ]
  } } })
}));
vi.mock("../../runProject.js", () => ({
  runDockerContainer: async () => undefined,
  createDockerRunInvocation: async (compiled: { report: { container: { persistent_mounts: Array<{ mount_path: string; volume_name: string }> } } }) => {
    state.pending.push(Object.fromEntries(compiled.report.container.persistent_mounts.map((mount) => [mount.mount_path, mount.volume_name])));
    return { args: [], command: "docker", envFilePath: "/nonexistent", supportDirectory: path.join(state.root, "support") };
  }
}));
// The organization: reads its assignment index through the feed's `current`, as the newsroom does.
vi.mock("../../runProjectLifecycle.js", () => ({
  executeDockerRunWithSupportCleanup: async () => {
    const volumes = state.pending.shift()!;
    const corpus = path.join(state.root, "volumes", volumes[BACKING]!);
    const edition = path.join(state.root, "volumes", volumes[STATE]!);
    state.boots.push({ volumes,
      index: await readFile(path.join(corpus, "current/2026-10-05/desks/writer.index"), "utf8").catch(() => null),
      seed: await readFile(path.join(edition, "editions/2026-10-05/seed.json"), "utf8").catch(() => null),
      sentinel: await readFile(path.join(corpus, ".spawnfile-resource-identity"), "utf8").catch(() => null) });
  }
}));

const { prepareTrial } = await import("./boot.js");

/** Docker volumes as local directories; a fill helper runs its program on them for real, as this uid. */
const calls: string[][] = [];
const docker = async (args: readonly string[], options: { stdin?: string | Buffer } = {}): Promise<string> => {
  calls.push([...args]);
  const volume = (name: string) => path.join(state.root, "volumes", name);
  if (args[0] === "volume" && args[1] === "create") { await mkdir(volume(args[2]!), { recursive: true }); return ""; }
  if (args[0] === "volume" && args[1] === "rm") {
    // Docker removes a volume as root; here the frozen trees are made writable first.
    await run("chmod", ["-R", "u+w", volume(args[3]!)]).catch(() => undefined);
    await rm(volume(args[3]!), { recursive: true, force: true });
    return "";
  }
  if (args[0] === "inspect") return "true 0";
  if (args[0] !== "run") return "";
  const mount = args[args.indexOf("--mount") + 1]!;
  const { source } = Object.fromEntries(mount.split(",").map((pair) => pair.split("=") as [string, string]));
  const program = args.indexOf("-e");
  const [uid, , identity, tree, feed] = args.slice(program + 2);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", args[program + 1]!, uid!, volume(source!), identity!, tree!, feed!],
      (error) => error ? reject(error) : resolve());
    child.stdin!.end(options.stdin ?? "");
  });
  return "";
};

beforeEach(async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-boot-moments-"));
  state.boots = []; state.pending = []; calls.length = 0;
});
afterEach(async () => {
  await run("chmod", ["-R", "u+w", state.root]).catch(() => undefined);
  await rm(state.root, { recursive: true, force: true });
});

/** A corpus repository with one edition branch, the shape of the newsroom's research corpus. */
const corpus = async (index: string): Promise<string> => {
  const repo = path.join(state.root, `corpus-${index}`);
  await mkdir(path.join(repo, "2026-10-05/desks"), { recursive: true });
  await writeFile(path.join(repo, "2026-10-05/desks/writer.index"), index);
  await mkdir(path.join(repo, "2026-10-06"), { recursive: true });
  await writeFile(path.join(repo, "2026-10-06/later.md"), "tomorrow");
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "edition"]]) {
    await run("git", ["-C", repo, ...args]);
  }
  return repo;
};

const momentOf = async (index: string): Promise<TrainingMoment> => {
  const repo = await corpus(index);
  const resolved = resolveFeedSource({ kind: "git", repo, ref: "HEAD", fetch: false, paths: ["2026-10-05"] });
  const source = resolved.provenance as Extract<typeof resolved.provenance, { kind: "git" }>;
  return { version: TRAINING_MOMENT_VERSION, at: "2026-10-05T11:45:40.170Z",
    wake: { surface: "moltnet", room: "assignment", from: "brass", text: "@writer file it" },
    resources: [
      { id: "research-corpus", fill: { kind: "git", repo, commit: source.commit, paths: source.paths, revision: resolved.revision, source } },
      { id: "edition-state", fill: { kind: "files", files: { "editions/2026-10-05/seed.json": `{"index":"${index}"}` } } }
    ] };
};

const boot = async (trialId: string, moment: TrainingMoment | undefined) => {
  const prepared = await prepareTrial({ agentManifestPath: "/nonexistent/Spawnfile", directory: path.join(state.root, trialId), docker,
    instructions: "i", trialId, control: async () => ({ status: 200, body: "{}" }) });
  return prepared.boot(null, { readyTimeoutMs: 1_000, ...(moment ? { moment } : {}) });
};

it("boots each trial on its moment's state, filled into its own volume before the organization starts", async () => {
  const trial = await boot("one", await momentOf("row: s-dd60a272"));
  expect(state.boots).toEqual([expect.objectContaining({ index: "row: s-dd60a272", seed: '{"index":"row: s-dd60a272"}',
    sentinel: `sha256:${"a".repeat(64)}\n` })]);
  const corpusVolume = path.join(state.root, "volumes", state.boots[0]!.volumes[BACKING]!);
  // Only the moment's paths land, frozen, as a feed serves them; nothing from a later edition leaks in.
  expect(await readlink(path.join(corpusVolume, "current"))).toMatch(/^trees\/[0-9a-f]{64}$/u);
  await expect(readFile(path.join(corpusVolume, "current/2026-10-06/later.md"))).rejects.toThrow();
  expect(JSON.parse(await readFile(path.join(corpusVolume, ".spawnfile-feed.json"), "utf8"))).toMatchObject({
    resource: "research-corpus", volume: "desk-corpus", version: "spawnfile.volume-feed.v1", files: 1 });
  await trial.teardown();
  // Teardown removes the trial's volumes, never the declared production names.
  const removed = calls.filter((args) => args[0] === "volume" && args[1] === "rm").map((args) => args[3]);
  expect(removed).toEqual(Object.values(state.boots[0]!.volumes));
  expect(removed).not.toContain("desk-corpus");
});

it("runs the dataset's after-boot steps in the started organization, in order, before it is handed over", async () => {
  const moment = { ...await momentOf("row"), afterBoot: [
    { user: "0:0", command: ["node", "bootstrap.mjs", "materialize"], env: { CONTROL_URL: "http://127.0.0.1:19700" } },
    { user: "2000:2000", command: ["node", "bootstrap.mjs", "verify"] }] };
  const trial = await boot("steps", moment);
  const execs = calls.filter((args) => args[0] === "exec");
  expect(execs.slice(0, 2)).toEqual([
    ["exec", "--user", "0:0", "-e", "CONTROL_URL=http://127.0.0.1:19700", trial.container, "node", "bootstrap.mjs", "materialize"],
    ["exec", "--user", "2000:2000", trial.container, "node", "bootstrap.mjs", "verify"]]);
  await trial.teardown();
});

it("boots on empty state without a moment", async () => {
  await (await boot("plain", undefined)).teardown();
  expect(state.boots).toEqual([expect.objectContaining({ index: null, seed: null, sentinel: null })]);
});

it("gives two concurrent trials of one project separate volumes, each with its own moment", async () => {
  const [first, second] = await Promise.all([momentOf("first"), momentOf("second")]);
  const trials = await Promise.all([boot("left", first), boot("right", second)]);
  expect(state.boots.map((entry) => entry.index).sort()).toEqual(["first", "second"]);
  const [left, right] = state.boots.map((entry) => Object.values(entry.volumes));
  expect(left!.filter((volume) => right!.includes(volume))).toEqual([]);
  for (const volume of [...left!, ...right!]) expect(volume).toMatch(/^spawnfile-training-trial-/u);
  await Promise.all(trials.map((trial) => trial.teardown()));
});

it("reads a wake's usage after its turn ends, not when a mid-turn disposition settles its receipt", async () => {
  const execution = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
  const usage = JSON.stringify({ v: "noopolis.daimon.turn-usage.v1", agent: "agent:writer", wake: execution, engine: "codex", at: "2026-11-04T00:00:00.000Z",
    input: 11_138, output: 35, cache_read: 0, cache_write: 0, total: 11_173, calls: 1, complete: true, notional_usd: 0 });
  let running = 2;
  const control = async (_target: unknown, method: string, route: string) => {
    if (method === "POST" && route === "/v2/wakes") return { status: 202, body: JSON.stringify({ state: "accepted", acceptance_id: "a-1" }) };
    // The subject disposed of its delivery with a tool call; its engine turn is still finishing.
    if (route.startsWith("/v2/wake-receipts/")) return { status: 200, body: JSON.stringify({ state: "completed", execution_id: execution, text: "filed" }) };
    if (route === "/v2/activity") return { status: 200, body: JSON.stringify({ executions: running-- > 0 ? [{ agent_id: "agent:writer", execution_id: execution, state: "running" }] : [] }) };
    return { status: 200, body: "{}" };
  };
  // The engine appends its usage row only when the turn ends.
  const ledger = async (args: readonly string[], options?: { stdin?: string | Buffer }) =>
    args[0] === "exec" && args.at(-1)?.endsWith("usage.jsonl") ? (running < 0 ? `${usage}\n` : "") : docker(args, options);
  const prepared = await prepareTrial({ agentManifestPath: "/nonexistent/Spawnfile", directory: path.join(state.root, "usage"), docker: ledger,
    instructions: "i", trialId: "usage", control: control as never });
  const trial = await prepared.boot(null, { readyTimeoutMs: 1_000 });
  const wake = await trial.wake("go", { deliveryId: "d-1", timeoutMs: 10_000 });
  expect(wake.usage.map((row) => [row.input, row.output])).toEqual([[11_138, 35]]);
  await trial.teardown();
}, 20_000);
