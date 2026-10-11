import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHistory } from "./history.js";
import { type LeakCheck, type MaterializedInput } from "./contract.js";
import { momentRecordSchema } from "../../../recording/index.js";
import { inspectVolumeBundle } from "./leakInputs.js";
import { writeRecordedVolumeSnapshot } from "./snapshotFixtures.test-helper.js";
import type { InputContext } from "./types.js";
import { materializeVolume } from "./volumes.js";

const at = "2026-10-09T10:00:00Z", before = "2026-10-09T09:00:00Z", future = "2026-10-09T10:00:00.001Z";
const temps: string[] = [];
afterEach(async () => { await Promise.all(temps.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const fixtures = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "rewind-volumes-"))); temps.push(root);
  const context: InputContext = { at, record: null, history: await openHistory(root), destination: path.join(root, "out"),
    agentSlug: "writer-compiled-slug", agentId: "agent:writer",
    input: { section: "resources", id: "state", declaredBy: "team:org", declarationBase: root, overridden: false,
      declaration: { id: "state", kind: "volume", mount: "./state", mode: "mutable" } } };
  const snapshot = (name: string, startedAt: string, files: Record<string, string> = {}) => writeRecordedVolumeSnapshot(root,
    { agentSlug: context.agentSlug!, agentId: context.agentId!, rootId: "state", snapshot: name, startedAt, files });
  return { root, context, snapshot };
};
const record = (snapshot: string) => momentRecordSchema.parse({ version: "spawnfile.moment-record.v1", agent: "agent:writer",
  wake: { at, startedAt: at, executionId: "execution", deliveries: [{ deliveryId: "wake", kind: "message", occurredAt: at }] },
  recordedAt: at, exact: true, resources: [], feeds: [], memory: [], moltnet: [], volumes: [{ id: "state", snapshot }] });
const report = (): LeakCheck => ({ version: "spawnfile.leak-check.v1", at, ok: false,
  checked: { files: 0, gitObjects: 0, memoryEvents: 0, moltnetMessages: 0, moltnetEvents: 0, snapshots: 0 }, findings: [] });

describe("unfed recorded volume trees", () => {
  it("requires the merged completion marker in both selection and independent acceptance", async () => {
    const { root, context, snapshot } = await fixtures();
    const saved = await snapshot("20261009T090000000Z-completed", before, { data: "bytes" });
    const result = await materializeVolume(context);
    await rm(`${saved.directory}.complete`);
    context.destination += "-incomplete";
    await expect(materializeVolume(context)).rejects.toThrow("No complete volume snapshot");
    const input: MaterializedInput = { section: "resources", id: "state", declaredBy: "team:org", kind: "volume", path: "out",
      fidelity: result.fidelity, basis: result.basis, source: result.source, notes: [], refusal: null };
    await expect(inspectVolumeBundle(root, input, report(), context.history)).rejects.toThrow("Snapshot tree or manifest is missing");
  });

  it("uses the merged row parser's nonempty delivery requirement", async () => {
    const { context, snapshot } = await fixtures();
    const saved = await snapshot("20261009T090000000Z-deliveries", before, { data: "bytes" });
    const row = JSON.parse(await readFile(saved.rowsPath, "utf8")); row.deliveries = [];
    await writeFile(saved.rowsPath, `${JSON.stringify(row)}\n`);
    await expect(materializeVolume(context)).rejects.toThrow(/wake-moments.jsonl:1:/u);
  });

  it("selects by inclusive row started_at, copies a full tree, and uses the named record exactly", async () => {
    const { context, snapshot } = await fixtures();
    await snapshot("20261009T080000000Z-first", before, { old: "old" });
    const newest = await snapshot("20261009T070000000Z-newest", "2026-10-09T12:00:00+02:00", { "nested/new": "new" });
    await snapshot("20261009T060000000Z-future", future, { later: "future" });
    expect(await materializeVolume(context)).toMatchObject({ fidelity: "approximate", basis: "snapshot-at",
      source: { snapshot: "20261009T070000000Z-newest", agentSlug: "writer-compiled-slug" } });
    expect(await readdir(context.destination)).toEqual(["nested"]);
    expect(await readFile(path.join(context.destination, "nested/new"), "utf8")).toBe("new");
    expect((await lstat(path.join(context.destination, "nested/new"))).ino)
      .not.toBe((await lstat(path.join(newest.directory, "nested/new"))).ino);
    context.destination += "-record"; context.record = record("20261009T080000000Z-first");
    expect(await materializeVolume(context)).toMatchObject({ fidelity: "exact", basis: "record" });
    expect(await readFile(path.join(context.destination, "old"), "utf8")).toBe("old");
  });

  it("ignores incomplete and .partial trees and chooses the last row when instants tie", async () => {
    const { context, snapshot } = await fixtures();
    await snapshot("20261009T090000000Z-first", before, { data: "first" });
    await snapshot("20261009T090000000Z-tie", before, { data: "last" });
    const incomplete = await snapshot("20261009T090000000Z-incomplete", at, { data: "unfinished" });
    await rm(incomplete.manifestPath);
    await snapshot("20261009T090000000Z-incoming.partial", at, { data: "partial" });
    expect(await materializeVolume(context)).toMatchObject({ source: { snapshot: "20261009T090000000Z-tie" } });
    expect(await readFile(path.join(context.destination, "data"), "utf8")).toBe("last");
    context.record = record("20261009T090000000Z-incoming.partial"); context.destination += "-record";
    await expect(materializeVolume(context)).rejects.toThrow(/partial/i);
  });

  it("creates an empty overridden volume without history", async () => {
    const { context } = await fixtures(); context.history = undefined; context.input.overridden = true;
    expect(await materializeVolume(context)).toMatchObject({ fidelity: "overridden", basis: "override" });
    expect(await readdir(context.destination)).toEqual([]);
  });

  it("refuses missing history, missing rows, future-only snapshots, and absent named snapshots", async () => {
    const { context, snapshot } = await fixtures();
    await expect(materializeVolume(context)).rejects.toThrow("Missing volume snapshot history");
    await snapshot("20261009T090000000Z-future", future);
    await expect(materializeVolume(context)).rejects.toThrow("No complete volume snapshot");
    context.record = record("20261009T090000000Z-missing");
    await expect(materializeVolume(context)).rejects.toThrow("Recorded volume snapshot 20261009T090000000Z-missing");
    context.history = undefined;
    await expect(materializeVolume(context)).rejects.toThrow("requires --history");
  });

  it("refuses invalid rows with line numbers and mismatched manifest identity", async () => {
    const { context, snapshot } = await fixtures(), saved = await snapshot("20261009T090000000Z-one", before, { data: "bytes" });
    await writeFile(saved.rowsPath, `${await readFile(saved.rowsPath, "utf8")}{}\n`);
    await expect(materializeVolume(context)).rejects.toThrow("wake-moments.jsonl:2");
    await writeFile(saved.rowsPath, (await readFile(saved.rowsPath, "utf8")).split("\n")[0] + "\n");
    await writeFile(saved.manifestPath, JSON.stringify({ ...saved.manifest, id: "other" }));
    await expect(materializeVolume(context)).rejects.toThrow("manifest identity");
  });

  it.each(["extra", "missing", "type", "size", "mode", "unsafe"])("refuses manifest %s mismatches", async (mutation) => {
    const { context, snapshot } = await fixtures(), saved = await snapshot("20261009T090000000Z-one", before, { data: "bytes" });
    if (mutation === "extra") await writeFile(path.join(saved.directory, "extra"), "extra");
    if (mutation === "missing") await rm(path.join(saved.directory, "data"));
    if (mutation === "type") { await rm(path.join(saved.directory, "data")); await mkdir(path.join(saved.directory, "data")); }
    if (mutation === "size") await writeFile(path.join(saved.directory, "data"), "shortened");
    if (mutation === "mode") await chmod(path.join(saved.directory, "data"), 0o600);
    if (mutation === "unsafe") {
      const manifest = JSON.parse(await readFile(saved.manifestPath, "utf8"));
      manifest.entries["../escape"] = manifest.entries.data; await writeFile(saved.manifestPath, JSON.stringify(manifest));
    }
    await expect(materializeVolume(context)).rejects.toThrow({
      extra: "Unexpected snapshot entry extra", missing: "Missing snapshot entry data", type: "Snapshot type mismatch for data",
      size: "Snapshot size mismatch for data", mode: "Snapshot mode mismatch for data", unsafe: "Snapshot paths must be normalized"
    }[mutation]!);
  });

  it("restores recorded directory modes without comparing nonportable directory sizes and verifies symlinks", async () => {
    const { context, root } = await fixtures();
    const saved = await writeRecordedVolumeSnapshot(root, { agentSlug: context.agentSlug!, agentId: context.agentId!, rootId: "state",
      snapshot: "20261009T090000000Z-tree", startedAt: before, files: { "nested/data": "bytes" }, directories: { nested: 0o750 }, symlinks: { link: "nested/data" } });
    const manifest = JSON.parse(await readFile(saved.manifestPath, "utf8"));
    manifest.entries.nested.size = "999999"; manifest.entries.nested.source.size = "999999";
    await writeFile(saved.manifestPath, JSON.stringify(manifest)); await chmod(path.join(saved.directory, "nested"), 0o700);
    await materializeVolume(context);
    expect((await lstat(path.join(context.destination, "nested"))).mode & 0o777).toBe(0o750);
    expect(await readlink(path.join(context.destination, "link"))).toBe("nested/data");
    manifest.entries.link.target = "other/data";
    await writeFile(saved.manifestPath, JSON.stringify(manifest)); context.destination += "-bad-link";
    await expect(materializeVolume(context)).rejects.toThrow(/symlink target/i);
  });

  it.each(["bytes", "mode", "extra", "missing", "target"])("independently rejects a bundle %s mutation", async (mutation) => {
    const { root, context } = await fixtures();
    await writeRecordedVolumeSnapshot(root, { agentSlug: context.agentSlug!, agentId: context.agentId!, rootId: "state",
      snapshot: "20261009T090000000Z-one", startedAt: before, files: { data: "bytes", other: "other" }, symlinks: { link: "data" } });
    const result = await materializeVolume(context);
    if (mutation === "bytes") await writeFile(path.join(context.destination, "data"), "wrong");
    if (mutation === "mode") await chmod(path.join(context.destination, "data"), 0o600);
    if (mutation === "extra") await writeFile(path.join(context.destination, "extra"), "extra");
    if (mutation === "missing") await rm(path.join(context.destination, "other"));
    if (mutation === "target") {
      await rm(path.join(context.destination, "link")); await symlink("other", path.join(context.destination, "link"));
    }
    const input: MaterializedInput = { section: "resources", id: "state", declaredBy: "team:org", kind: "volume", path: "out",
      fidelity: result.fidelity, basis: result.basis, source: result.source, notes: [], refusal: null };
    const check = report(); await inspectVolumeBundle(root, input, check, context.history);
    expect(check.findings).toContainEqual(expect.objectContaining({ class: "snapshot", path: "out", detail: expect.stringMatching({
      bytes: /Snapshot digest mismatch for data/, mode: /Snapshot mode mismatch for data/, extra: /Unexpected snapshot entry extra/,
      missing: /Missing snapshot entry other/, target: /Snapshot symlink target mismatch for link/
    }[mutation]!) }));
  });
});
