import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as deployment from "../../../deployment/index.js";
import { BundleTarWriter } from "../../workspaceBundleTar.js";
import { AT, BEFORE, emptyRecord, jsonl, rewindFixture, testGit } from "./fixtures.test-helper.js";
import { materializeTrainingMoment } from "./materialize.js";
import { composeMomentRecord } from "../../../recording/index.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const DIGEST = `sha256:${"a".repeat(64)}`;
const fixture = async (home = false) => {
  const f = await rewindFixture(); roots.push(f.root);
  testGit(f.gitRepo, ["checkout", "-B", "main", f.commit]);
  await writeFile(path.join(f.gitRepo, "news.txt"), "newer eligible selector\n");
  testGit(f.gitRepo, ["add", "."]); testGit(f.gitRepo, ["commit", "--quiet", "-m", "later"], "2026-10-09T08:00:00Z");
  const later = testGit(f.gitRepo, ["rev-parse", "HEAD"]);
  const recordPath = home ? "/original/home/deployments/desk/record.json" : "/original/output/deployments/desk.json";
  const logPath = home ? "deployments/desk/resource-log.jsonl" : "deployments/desk.resource-log.jsonl";
  const entry = (commit = f.commit, fields: Partial<deployment.DeployResources> = {}): deployment.DeployResources => ({
    version: "spawnfile.deploy-resources.v1", deployment: "desk", deployment_id: recordPath,
    deployed_at: "2026-10-10T00:00:00Z", activated_at: BEFORE, activation_exact: true, report_sha256: DIGEST,
    resources: [{ id: "code", kind: "git", commit, sha256: DIGEST, agent_node_ids: ["agent:a"], declared_by: "team:publication" }], ...fields
  });
  const log = (entries: unknown[]) => jsonl(f.historyDir, logPath, entries);
  const run = async () => {
    const result = await materializeTrainingMoment(f.options);
    return { result, input: result.inputs.find((input) => input.id === "code")! };
  };
  return { ...f, later, entry, log, run, logPath, recordPath };
};

describe("merged deployment resource history in rewind", () => {
  it.each((["git", "bundle"] as const).flatMap((kind) => ["activation", "rollback"].map((boundary) => ({ kind, boundary }))))
    ("downgrades a matched $kind record with non-exact $boundary", async ({ kind, boundary }) => {
      const f = await fixture();
      let sha256 = DIGEST;
      if (kind === "bundle") {
        const archive = path.join(f.root, "saved.tar"), writer = await BundleTarWriter.create(archive);
        await writer.begin("tools.txt", 6, 0o644); await writer.data(Buffer.from("tools\n")); await writer.end(); await writer.finish();
        const bytes = await readFile(archive), hex = createHash("sha256").update(bytes).digest("hex"); sha256 = `sha256:${hex}`;
        await mkdir(path.join(f.historyDir, "bundles")); await writeFile(path.join(f.historyDir, "bundles", `${hex}.tar`), bytes);
        const agent = f.project.compilePlan.nodes.find((node) => node.id === f.plan.agent.id)!.value;
        if (agent.kind !== "agent") throw new Error("Expected agent");
        const index = agent.workspaceResources!.findIndex((resource) => resource.id === "code");
        agent.workspaceResources![index] = { scope: agent.workspaceResources![index]!.scope, sharing: "per_agent", id: "code", kind,
          mount: "./code", mode: "readonly", source: "never-read.tar" };
      }
      const entry = f.entry(f.commit, { activation_exact: boundary !== "activation", activation_note: "Predecessor may still serve code",
        ...(boundary === "rollback" ? { exact: false, rolled_back_at: "2026-10-09T08:20:32Z" } : {}),
        resources: [{ id: "code", kind, sha256, ...(kind === "git" ? { commit: f.commit } : {}), agent_node_ids: ["agent:a"], declared_by: "team:publication" } as deployment.DeployResources["resources"][number]],
        recording_agents: [{ node_id: "agent:a", slug: "a", directory: "/recording/a", keep_ms: 1000,
          resources: [{ id: "code", kind }], feeds: [], memory: [], networks: [], snapshots: [] }] });
      const record = composeMomentRecord({ agentNodeId: "agent:a", deploymentRecordPath: f.recordPath, deployResources: [entry],
        row: { version: "noopolis.daimon.wake-moment.v1", agent_id: "agent:a", execution_id: "execution-17", started_at: AT,
          deliveries: [{ acceptance_id: "accepted", delivery_id: "schedule:edition", kind: "schedule", occurred_at: AT }], snapshots: [] },
        feedLandings: {}, memoryLedgers: {}, recordedAt: AT });
      expect(record.resources).toHaveLength(1);
      expect(record.errors).toContainEqual(expect.stringContaining("Deployment activation is non-exact"));
      await jsonl(f.historyDir, "moments/pin.jsonl", [record]);
      const { result, input } = await f.run();
      expect(result.status, JSON.stringify(result.inputs)).toBe("materialized");
      expect(result.record.matched).toBe(true);
      expect(input).toMatchObject({ basis: "record", fidelity: "approximate", notes: record.errors,
        source: kind === "git" ? { commit: f.commit } : { sha256 } });
    });

  it.each([false, true])("uses the deployed commit instead of a newer selector (home=%s)", async (home) => {
    const f = await fixture(home), lookup = vi.spyOn(deployment, "deployResourcesAt");
    const entry = f.entry(); await f.log([entry]);
    const { result, input } = await f.run();
    expect(result.status, JSON.stringify(result.inputs)).toBe("materialized");
    expect(input).toMatchObject({ fidelity: "exact", basis: "deploy-log", source: { commit: f.commit } });
    expect(await readFile(path.join(f.options.out, input.path!, "news.txt"), "utf8")).toBe("Before the wake\n");
    expect(lookup).toHaveBeenCalledWith([entry], f.recordPath, AT, "agent:a");
  });

  it.each(["2026-10-09T08:20:30Z", AT, "2026-10-09T08:20:32Z", "2026-10-09T08:20:32.001Z"])("respects inclusive rollback and restoration at %s", async (at) => {
    const f = await fixture();
    const activated_at = "2026-10-09T08:20:30Z", rolled_back_at = "2026-10-09T08:20:32Z";
    const candidate = f.entry(f.later, { activated_at, report_sha256: `sha256:${"b".repeat(64)}` });
    await f.log([f.entry(), candidate, { ...candidate, activation_exact: false, exact: false, rolled_back_at }]);
    // The dataset wake matches a record; all history must be selected at its effective startedAt.
    const record = emptyRecord(); record.wake.startedAt = at;
    await jsonl(f.historyDir, "moments/attempt.jsonl", [record]);
    const { result, input } = await f.run(), rolledBack = at === "2026-10-09T08:20:32.001Z";
    expect(result.status, JSON.stringify(result.inputs)).toBe("materialized");
    expect(input).toMatchObject({ basis: "deploy-log", fidelity: rolledBack ? "exact" : "approximate",
      source: { commit: rolledBack ? f.commit : f.later } });
    if (!rolledBack) expect(input.notes).toContainEqual(expect.stringContaining("rollback interval"));
  });

  it("carries an inexact activation note beside the selected pin", async () => {
    const f = await fixture(); await f.log([f.entry(f.commit, { activation_exact: false, activation_note: "Predecessor overlaps launch" })]);
    const { result, input } = await f.run();
    expect(result.status).toBe("materialized");
    expect(input).toMatchObject({ basis: "deploy-log", fidelity: "approximate", source: { commit: f.commit }, notes: ["Predecessor overlaps launch"] });
  });

  it.each(["before activation", "other agent", "other declaring node", "absent resource"])("uses selector-at only when the deploy pin is absent: %s", async (state) => {
    const f = await fixture(), entry = f.entry();
    if (state === "before activation") entry.activated_at = "2026-10-09T09:00:00Z";
    if (state === "other agent") entry.resources[0]!.agent_node_ids = ["agent:other"];
    if (state === "other declaring node") entry.resources[0]!.declared_by = "team:other";
    if (state === "absent resource") entry.resources = [];
    await f.log([entry]);
    expect((await f.run()).input).toMatchObject({ basis: "selector-at", fidelity: "approximate", source: { commit: f.later } });
  });

  it.each(["moment", "declared"])("preserves %s pin precedence over deployment history", async (kind) => {
    const f = await fixture(); await f.log([f.entry(f.later)]);
    if (kind === "moment") {
      const record = emptyRecord(); record.resources = [{ id: "code", kind: "git", commit: f.commit }];
      await jsonl(f.historyDir, "moments/pin.jsonl", [record]);
    } else {
      const agent = f.project.compilePlan.nodes.find((node) => node.id === f.plan.agent.id)!.value;
      if (agent.kind !== "agent") throw new Error("Expected agent");
      const resource = agent.workspaceResources!.find((item) => item.id === "code")!;
      if (resource.kind !== "git") throw new Error("Expected git"); resource.ref = f.commit;
    }
    expect((await f.run()).input).toMatchObject({ basis: kind === "moment" ? "record" : "pinned", fidelity: "exact", source: { commit: f.commit } });
  });

  it.each(["malformed", "mixed identities", "multiple logs", "duplicate pin"])("refuses %s instead of guessing selector-at", async (state) => {
    const f = await fixture(), entry = f.entry();
    if (state === "duplicate pin") entry.resources.push({ ...entry.resources[0]! });
    await f.log(state === "malformed" ? [entry, {}] : state === "mixed identities" ? [entry, { ...entry, deployment_id: "/other/desk.json" }] : [entry]);
    if (state === "multiple logs") await jsonl(f.historyDir, "deployments/other.resource-log.jsonl", [entry]);
    const { result, input } = await f.run();
    expect(result.status).toBe("refused");
    expect(input.refusal).toMatch(/Invalid history|deployment.*ambiguous|Ambiguous deployment/u);
    expect(await readdir(f.options.out)).toEqual(["moment.json"]);
  });

  it.each([true, false])("restores digest-verified deploy bundle bytes with activation_exact=%s", async (exact) => {
    const f = await fixture(), archive = path.join(f.root, "saved.tar");
    const writer = await BundleTarWriter.create(archive);
    await writer.begin("tools.txt", 6, 0o644); await writer.data(Buffer.from("tools\n")); await writer.end(); await writer.finish();
    const bytes = await readFile(archive), hex = createHash("sha256").update(bytes).digest("hex");
    await mkdir(path.join(f.historyDir, "bundles")); await writeFile(path.join(f.historyDir, "bundles", `${hex}.tar`), bytes);
    const agent = f.project.compilePlan.nodes.find((node) => node.id === f.plan.agent.id)!.value;
    if (agent.kind !== "agent") throw new Error("Expected agent");
    const index = agent.workspaceResources!.findIndex((item) => item.id === "code");
    agent.workspaceResources![index] = { scope: agent.workspaceResources![index]!.scope, sharing: "per_agent", id: "code", kind: "bundle", mount: "./code", mode: "readonly", source: "never-read.tar" };
    await f.log([f.entry(f.commit, { activation_exact: exact, resources: [{ id: "code", kind: "bundle", sha256: `sha256:${hex}`,
      agent_node_ids: ["agent:a"], declared_by: "team:publication" }] })]);
    const { result, input } = await f.run();
    expect(result.status, JSON.stringify(result.inputs)).toBe("materialized");
    expect(input).toMatchObject({ basis: "deploy-log", fidelity: exact ? "exact" : "approximate", source: { sha256: `sha256:${hex}` } });
    expect(await readFile(path.join(f.options.out, input.path!, "tools.txt"), "utf8")).toBe("tools\n");
  });

  it("refuses an unavailable deployment bundle instead of reconstructing a different selector", async () => {
    const f = await fixture(), agent = f.project.compilePlan.nodes.find((node) => node.id === f.plan.agent.id)!.value;
    if (agent.kind !== "agent") throw new Error("Expected agent");
    const index = agent.workspaceResources!.findIndex((item) => item.id === "code"), previous = agent.workspaceResources![index]!;
    agent.workspaceResources![index] = { scope: previous.scope, sharing: "per_agent", id: "code", kind: "bundle",
      mount: "./code", mode: "readonly", build: { files: { root: ".", ref: f.later } } };
    await f.log([f.entry(f.commit, { resources: [{ id: "code", kind: "bundle", sha256: DIGEST,
      agent_node_ids: ["agent:a"], declared_by: "team:publication" }] })]);
    const { result, input } = await f.run();
    expect(result.status).toBe("refused");
    expect(input.refusal).toContain(`Deployment bundle ${DIGEST} could not be reproduced`);
    expect(await readdir(f.options.out)).toEqual(["moment.json"]);
  });
});
