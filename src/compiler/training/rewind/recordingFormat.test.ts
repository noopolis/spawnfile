import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { momentRecordSchema, momentFileName, withMomentStore, writeMomentRecord, type WakeMomentRow } from "../../../recording/index.js";
import * as rewindContract from "./contract.js";
import { AT, BEFORE, emptyRecord, jsonl, memoryEvent, rewindFixture } from "./fixtures.test-helper.js";
import { gitTestRoot } from "./git.test-helper.js";
import { History } from "./history.js";
import { materializeTrainingMoment } from "./materialize.js";
import { selectMomentRecord } from "./select.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const recorded = () => ({
  version: "spawnfile.moment-record.v1" as const, agent: "agent:a",
  wake: { at: AT, startedAt: AT, executionId: "execution-17",
    deliveries: [{ deliveryId: "delivery-17", kind: "schedule", occurredAt: AT }] },
  recordedAt: AT, exact: true, resources: [], feeds: [], memory: [], moltnet: [], volumes: []
});

describe("P3 recording format", () => {
  it("leaves the moment record schema owned only by the recording barrel", () => {
    expect(rewindContract).not.toHaveProperty("momentRecordSchema");
  });
  it("accepts the recording shape and rejects the superseded sketch", () => {
    const value = { ...recorded(), exact: false, errors: ["volume state: capture failed"],
      resources: [{ id: "git", kind: "git", commit: "a".repeat(40) }, { id: "bundle", kind: "bundle", sha256: `sha256:${"b".repeat(64)}` }],
      feeds: [{ id: "directory", revision: "c".repeat(64), tree: `trees/${"c".repeat(64)}.1`, landedAt: BEFORE }],
      memory: [{ id: "self", declaredBy: "agent:a", seq: 0 }],
      moltnet: [{ network: "news", cursor: AT, messageIds: ["wake-message"] }] };
    expect(momentRecordSchema.parse(value)).toEqual(value);
    for (const invalid of [{ ...value, exact: undefined }, { ...value, wake: { at: AT } },
      { ...value, resources: [{ id: "bundle", kind: "bundle", commit: "a".repeat(40) }] },
      { ...value, moltnet: [{ network: "news", cursor: "message-id" }] }]) {
      expect(momentRecordSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("selects the original attempt by earliest startedAt, not capture or append order", () => {
    const first = { ...recorded(), memory: [{ id: "self", declaredBy: "agent:a", seq: 1 }] };
    const replay = { ...first, wake: { ...first.wake, at: "2026-10-09T10:20:31+02:00", startedAt: "2026-10-09T09:00:00Z" },
      memory: [{ id: "self", declaredBy: "agent:a", seq: 9 }] };
    expect(selectMomentRecord([replay, first], "agent:a", AT)).toBe(first);
  });

  it("reads nested per-file JSON moments as well as JSONL", async () => {
    const root = await gitTestRoot(); roots.push(root);
    await mkdir(path.join(root, "moments/a/day"), { recursive: true });
    await writeFile(path.join(root, "moments/a/day/turn.json"), JSON.stringify(recorded()));
    await jsonl(root, "moments/other/turns.jsonl", [{ ...recorded(), agent: "agent:other" }]);
    expect((await new History(root).records()).map((entry) => entry.agent)).toEqual(["agent:a", "agent:other"]);
  });
});

describe("recording pins in a materialized trial", () => {
  it.each([false, true])("consumes equal executionId+startedAt replay files and refuses differing decisions=%s", async (conflicting) => {
    const f = await rewindFixture(); roots.push(f.root);
    const first = emptyRecord(); first.memory = [{ id: "self", declaredBy: "agent:a", seq: 0 }];
    const second = structuredClone(first);
    second.wake.deliveries[0]!.deliveryId = "replay-delivery";
    if (conflicting) second.memory[0]!.seq = 1;
    const row = (record: typeof first): WakeMomentRow => ({ version: "noopolis.daimon.wake-moment.v1",
      agent_id: record.agent, execution_id: record.wake.executionId, started_at: record.wake.startedAt,
      deliveries: record.wake.deliveries.map((delivery) => ({ acceptance_id: delivery.deliveryId,
        delivery_id: delivery.deliveryId, kind: delivery.kind, occurred_at: delivery.occurredAt })), snapshots: [] });
    const slug = f.project.compilePlan.nodes.find((node) => node.id === f.plan.agent.id)!.slug;
    await withMomentStore(path.join(f.historyDir, "record.json"), slug, async (directory) => {
      for (const record of [second, first]) expect(await writeMomentRecord(directory, record, row(record))).toBe(true);
      expect(await readdir(directory)).toEqual(expect.arrayContaining([momentFileName(row(first)), momentFileName(row(second))]));
    });
    expect(momentFileName(row(first))).not.toBe(momentFileName(row(second)));
    const result = await materializeTrainingMoment(f.options);
    if (conflicting) {
      expect(result.status).toBe("refused");
      expect(result.inputs.find((input) => input.kind === "memory")!.refusal).toMatch(/Conflicting moment records.*memory agent:a\/self/u);
      expect(await readdir(f.options.out)).toEqual(["moment.json"]);
    } else {
      expect(result.status, JSON.stringify(result.inputs)).toBe("materialized");
      expect(result.record).toMatchObject({ matched: true, attempts: 2, executionId: first.wake.executionId, selectedStartedAt: AT });
      expect(result.inputs.find((input) => input.kind === "memory")).toMatchObject({ fidelity: "exact", source: { seq: 0 } });
    }
  });

  it.each(["json", "jsonl"])("applies shared recording validation to .%s discovery", async (suffix) => {
    const root = await gitTestRoot(); roots.push(root);
    const record = { ...recorded(), memory: [{ id: "self", declaredBy: "agent:a", seq: Number.MAX_SAFE_INTEGER + 1 }] };
    await mkdir(path.join(root, "moments/a"), { recursive: true });
    await writeFile(path.join(root, `moments/a/invalid.${suffix}`), `${JSON.stringify(record)}\n`);
    await expect(new History(root).records()).rejects.toThrow(/Invalid history moments\/a\/invalid/u);
  });

  it.each([false, true])("refuses conflicting copies instead of choosing the empty pin or nonempty fallback (reverse=%s)", async (reverse) => {
    const f = await rewindFixture(); roots.push(f.root);
    const healthy = emptyRecord(); healthy.memory = [{ id: "self", declaredBy: "agent:a", seq: 0 }];
    const errored = structuredClone(healthy); errored.exact = false; errored.errors = ["memory self: sequence capture failed"];
    await jsonl(f.historyDir, "memory/agent%3Aa/self/events.jsonl", [memoryEvent(1)]);
    await jsonl(f.historyDir, "moments/copies.jsonl", reverse ? [errored, healthy] : [healthy, errored]);
    const result = await materializeTrainingMoment(f.options);
    expect(result.status).toBe("refused");
    expect(result.inputs.find((input) => input.id === "self")!.refusal).toMatch(/Conflicting moment records.*memory agent:a\/self/u);
    expect(await readdir(f.options.out)).toEqual(["moment.json"]);
  });
  it.each([false, true])("accepts incoming feed publication metadata after the bound with record=%s", async (withRecord) => {
    const f = await rewindFixture(); roots.push(f.root);
    const log = "feeds/team%3Apublication/news/landings.jsonl";
    const landing = JSON.parse((await readFile(path.join(f.historyDir, log), "utf8")).trim());
    landing.switching_at = AT; landing.landed_at = "2026-10-09T08:20:32Z";
    if (withRecord) {
      const record = emptyRecord(); record.exact = false; record.errors = ["volume edition-state: snapshot failed"];
      record.feeds = [{ id: "news", revision: landing.revision, tree: landing.tree, commit: f.commit, ref: "main", landedAt: landing.landed_at }];
      await jsonl(f.historyDir, "moments/incoming.jsonl", [record]);
      await rm(path.join(f.historyDir, log));
    } else await jsonl(f.historyDir, log, [landing]);
    const result = await materializeTrainingMoment(f.options);
    expect(result, JSON.stringify(result.inputs)).toMatchObject({ status: "materialized", leakCheck: { ok: true } });
    expect(result.inputs.find((input) => input.kind === "feed")).toMatchObject({ fidelity: withRecord ? "exact" : "approximate",
      basis: withRecord ? "record" : "landing-log", source: { landedAt: landing.landed_at } });
  });

  it("uses startedAt for task time and leak bounds, reports original selection and keeps wake at", async () => {
    const f = await rewindFixture(); roots.push(f.root);
    const first = emptyRecord(); first.wake.startedAt = "2026-10-09T08:21:00Z";
    first.memory = [{ id: "self", declaredBy: "agent:a", seq: 2 }];
    const replay = structuredClone(first); replay.wake.startedAt = "2026-10-09T09:00:00Z"; replay.memory[0]!.seq = 3;
    await jsonl(f.historyDir, "moments/attempts.jsonl", [replay, first]);
    const result = await materializeTrainingMoment(f.options);
    expect(result, JSON.stringify(result.inputs)).toMatchObject({ status: "materialized", at: AT, effectiveAt: first.wake.startedAt,
      record: { matched: true, attempts: 2, selectedStartedAt: first.wake.startedAt, selection: "earliest-startedAt" } });
    expect(result.inputs.find((input) => input.kind === "memory")).toMatchObject({ fidelity: "exact", source: { seq: 2 } });
    expect(JSON.parse(await readFile(path.join(f.options.out, "task-clock.json"), "utf8")).origin).toBe(first.wake.startedAt);
    expect(JSON.parse(await readFile(path.join(f.options.out, "leak-check.json"), "utf8"))).toMatchObject({ at: first.wake.startedAt, ok: true });
  });

  it("keeps healthy pins exact in an inexact record and annotates absent pins", async () => {
    const f = await rewindFixture(); roots.push(f.root);
    const record = emptyRecord(); record.exact = false; record.errors = ["volume edition-state: snapshot failed"];
    record.resources = [{ id: "code", kind: "git", commit: f.commit }];
    record.memory = [{ id: "self", declaredBy: "agent:a", seq: 0 }];
    await jsonl(f.historyDir, "moments/inexact.jsonl", [record]);
    const result = await materializeTrainingMoment(f.options);
    expect(result.status).toBe("materialized");
    expect(result.inputs.find((input) => input.id === "code")).toMatchObject({ fidelity: "exact", basis: "record" });
    expect(result.inputs.find((input) => input.id === "self")).toMatchObject({ fidelity: "exact", basis: "record", source: { seq: 0 } });
    expect(result.inputs.find((input) => input.id === "edition-state")).toMatchObject({ fidelity: "approximate",
      notes: expect.arrayContaining(record.errors) });
  });

  it("does not trust a present pin named by the record errors", async () => {
    const f = await rewindFixture(); roots.push(f.root);
    const record = emptyRecord(); record.exact = false; record.errors = ["memory self: sequence capture failed"];
    record.memory = [{ id: "self", declaredBy: "agent:a", seq: 0 }];
    await jsonl(f.historyDir, "moments/inexact.jsonl", [record]);
    await jsonl(f.historyDir, "memory/agent%3Aa/self/events.jsonl", [memoryEvent(1)]);
    const result = await materializeTrainingMoment(f.options);
    expect(result.status).toBe("materialized");
    expect(result.inputs.find((input) => input.id === "self")).toMatchObject({ fidelity: "approximate", basis: "created-at-prefix",
      source: { seq: 1 }, notes: expect.arrayContaining(record.errors) });
  });
});
