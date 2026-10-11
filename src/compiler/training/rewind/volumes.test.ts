import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHistory } from "./history.js";
import { momentRecordSchema } from "./contract.js";
import type { InputContext } from "./types.js";
import { materializeVolume, replayVolumeSnapshot, selectVolumeSnapshot, type VolumeSnapshot } from "./volumes.js";

const at = "2026-10-09T10:00:00Z", before = "2026-10-09T09:00:00Z", future = "2026-10-09T10:00:00.001Z";
const digest = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const snapshot = (id: string, time: string, parent: string | null, files: VolumeSnapshot["files"]): VolumeSnapshot =>
  ({ snapshot: id, takenAt: time, parent, files });
const fixtures = async (snapshots?: VolumeSnapshot[]) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rewind-volumes-")); temps.push(root);
  const bank = path.join(root, "volumes/team%3Aorg/state"); await mkdir(path.join(bank, "objects"), { recursive: true });
  if (snapshots) await writeFile(path.join(bank, "snapshots.jsonl"), snapshots.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const context: InputContext = { at, record: null, history: await openHistory(root), destination: path.join(root, "out"),
    input: { section: "resources", id: "state", declaredBy: "team:org", declarationBase: root, overridden: false,
      declaration: { id: "state", kind: "volume", mount: "./state", mode: "mutable" } } };
  return { root, bank, context, object: async (bytes: string) => writeFile(path.join(bank, "objects", digest(bytes)), bytes) };
};

describe("unfed volume replay", () => {
  it("includes equal instants, excludes one millisecond later, and selects an ancestor record exactly", async () => {
    const rows = [snapshot("first", before, null, { old: digest("old") }),
      snapshot("next", "2026-10-09T12:00:00+02:00", "first", { old: null, "nested/new": digest("new") }),
      snapshot("future", future, "next", { later: digest("future") })];
    expect(selectVolumeSnapshot(rows, at).snapshot).toBe("next");
    expect(selectVolumeSnapshot(rows, at, "first").snapshot).toBe("first");
    expect(replayVolumeSnapshot(rows, "next").files).toEqual({ "nested/new": digest("new") });
    const { context, object } = await fixtures(rows); await object("old"); await object("new");
    const result = await materializeVolume(context);
    expect(result).toMatchObject({ fidelity: "approximate", basis: "snapshot-at", source: { snapshot: "next" } });
    expect(await readdir(context.destination)).toEqual(["nested"]);
    expect(await readFile(path.join(context.destination, "nested/new"), "utf8")).toBe("new");
    context.destination += "-record";
    context.record = momentRecordSchema.parse({ version: "spawnfile.moment-record.v1", agent: "agent:writer",
      wake: { at, surface: "moltnet", room: "assignment", from: "brass" }, recordedAt: at,
      resources: [], feeds: [], memory: [], moltnet: [], volumes: [{ id: "state", snapshot: "first" }] });
    expect(await materializeVolume(context)).toMatchObject({ fidelity: "exact", basis: "record", source: { snapshot: "first" } });
    expect(await readFile(path.join(context.destination, "old"), "utf8")).toBe("old");
  });

  it("creates an empty overridden volume without history", async () => {
    const { context } = await fixtures(); context.history = undefined; context.input.overridden = true;
    expect(await materializeVolume(context)).toMatchObject({ fidelity: "overridden", basis: "override" });
    expect(await readdir(context.destination)).toEqual([]);
  });

  it("refuses unavailable history, future-only snapshots, divergent pins, cycles and missing ancestors", async () => {
    const { context } = await fixtures();
    await expect(materializeVolume(context)).rejects.toThrow("Missing volume snapshot history");
    context.history = undefined;
    await expect(materializeVolume(context)).rejects.toThrow("requires --history");
    expect(() => selectVolumeSnapshot([snapshot("late", future, null, {})], at)).toThrow("No volume snapshot");
    const rows = [snapshot("one", before, null, {}), snapshot("other", at, null, {})];
    expect(() => selectVolumeSnapshot(rows, at, "one")).toThrow("not the latest eligible snapshot or its ancestor");
    expect(() => replayVolumeSnapshot([snapshot("one", at, "missing", {})], "one")).toThrow("Missing volume snapshot ancestor");
    expect(() => replayVolumeSnapshot([snapshot("one", at, "one", {})], "one")).toThrow("Cycle");
    expect(() => replayVolumeSnapshot([snapshot("one", at, null, {}), snapshot("two", before, "one", {})], "two")).toThrow("later than child");
  });

  it("breaks same-instant ties only by ancestry and refuses malformed records and unsafe paths", async () => {
    const rows = [snapshot("one", at, null, {}), snapshot("two", at, "one", {})];
    expect(selectVolumeSnapshot(rows, at).snapshot).toBe("two");
    expect(() => selectVolumeSnapshot([...rows, snapshot("three", at, null, {})], at)).toThrow("Ambiguous");
    expect(() => replayVolumeSnapshot([rows[0]!, rows[0]!], "one")).toThrow("Duplicate");
    expect(() => replayVolumeSnapshot([snapshot("one", at, null, { a: digest("a"), "a/b": digest("b") })], "one")).toThrow("collision");
    const { context, bank } = await fixtures();
    await writeFile(path.join(bank, "snapshots.jsonl"), JSON.stringify({ ...rows[0], unexpected: true }) + "\n");
    await expect(materializeVolume(context)).rejects.toThrow("snapshots.jsonl:1");
    await writeFile(path.join(bank, "snapshots.jsonl"), JSON.stringify(snapshot("one", at, null, { "../escape": digest("x") })) + "\n");
    await expect(materializeVolume(context)).rejects.toThrow("normalized relative POSIX");
  });

  it("verifies every chain object, including deleted bytes, and refuses symlink escape", async () => {
    const { context, bank, root, object } = await fixtures([
      snapshot("one", before, null, { old: digest("old") }), snapshot("two", at, "one", { old: null })]);
    await expect(materializeVolume(context)).rejects.toThrow("Missing volume snapshot object");
    await object("old"); await writeFile(path.join(bank, "objects", digest("old")), "tampered");
    await expect(materializeVolume(context)).rejects.toThrow("SHA-256 mismatch");
    const outside = await mkdtemp(path.join(os.tmpdir(), "rewind-volume-outside-")); temps.push(outside);
    await writeFile(path.join(outside, "object"), "old");
    await rm(path.join(bank, "objects", digest("old")));
    await symlink(path.join(outside, "object"), path.join(bank, "objects", digest("old")));
    await expect(materializeVolume(context)).rejects.toThrow("symlink escape");
    expect(await readdir(root)).not.toContain("out");
  });
});
