import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { recordDeploymentRollback } from "./candidateRecording.js";
import { createDeployResources, deployResourcesAt, ensureDeployResources, readDeployResources } from "./resourceLog.js";

let root: string;
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const report = (pin: string) => ({ recording: { keep_ms: 2 * 86_400_000, memory_mount_ids: [] },
  workspace_git_resources: [{ id: "archive", agent_node_ids: ["agent:writer"], commit: pin.repeat(40), sha256: `sha256:${pin.repeat(64)}` }] });
const record = (day: number) => ({ name: "news", created_at: at(day), activated_at: at(day), activation_exact: true });
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-candidate-")); vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

it("uses the candidate interval inclusively, excludes its published snapshot afterward, and retains the restored predecessor", async () => {
  const file = path.join(root, "news.json");
  vi.setSystemTime(new Date(at(1)));
  const previous = createDeployResources(file, record(1), report("a"), "A");
  ensureDeployResources(file, previous, report("a").recording.keep_ms);
  vi.setSystemTime(new Date(at(3)));
  const candidate = createDeployResources(file, record(3), report("b"), "B");
  ensureDeployResources(file, candidate, report("b").recording.keep_ms);
  vi.setSystemTime(new Date(at(4)));
  await recordDeploymentRollback(file, record(3), report("b"), "B", at(4));
  let entries = readDeployResources(file).entries;
  for (const instant of [at(3), new Date(Date.parse(at(3)) + 1000), at(4)]) {
    expect(deployResourcesAt(entries, file, instant, "agent:writer")).toMatchObject({ exact: false, activation_exact: false, resources: [expect.objectContaining({ commit: "b".repeat(40) })] });
  }
  expect(deployResourcesAt(entries, file, at(2))).toEqual(previous);
  expect(deployResourcesAt(entries, file, at(5))).toEqual(previous);
  expect(deployResourcesAt(entries, path.join(root, "other.json"), at(3))).toBeNull();
  expect(deployResourcesAt(entries, file, at(3), "other-agent")!.resources).toEqual([]);
  vi.setSystemTime(new Date(at(9)));
  ensureDeployResources(file, createDeployResources(file, record(9), report("c"), "C"), report("c").recording.keep_ms);
  entries = readDeployResources(file).entries;
  expect(entries).toHaveLength(2);
  expect(deployResourcesAt(entries, file, at(8))).toEqual(previous);
});

it("retains an interval crossing the cutoff and the predecessor needed after it ends", async () => {
  const file = path.join(root, "news.json");
  vi.setSystemTime(new Date(at(1)));
  const previous = createDeployResources(file, record(1), report("a"), "A");
  ensureDeployResources(file, previous, report("a").recording.keep_ms);
  vi.setSystemTime(new Date(at(9)));
  await recordDeploymentRollback(file, record(3), report("b"), "B", at(9));
  const entries = readDeployResources(file).entries;
  expect(deployResourcesAt(entries, file, at(7))).toMatchObject({ exact: false });
  expect(deployResourcesAt(entries, file, new Date(Date.parse(at(9)) + 1))).toEqual(previous);
});

it("does no rollback-recording I/O when disabled", async () => {
  const file = path.join(root, "absent", "news.json");
  await recordDeploymentRollback(file, record(1), {}, "", at(2));
  expect(existsSync(path.dirname(file))).toBe(false);
});
