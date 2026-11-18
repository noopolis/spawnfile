import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import type { ResolvedAuthProfile } from "../../../../auth/index.js";
import type { PreparedTrial, TrialOptions, TrialWake } from "./boot.js";
import { createBootedTrialRun } from "./launcher.js";
import { openDaimonJudgmentCacheStore } from "./judgmentCache.js";
import { compiledAgentDigest } from "../../../../compiler/training/trial/cache/index.js";
import { openTrialCacheStore, type TrialCacheMode } from "../../../../compiler/training/trial/cache/index.js";

const profile: ResolvedAuthProfile = { authHome: "/x", env: {}, imports: {}, name: "training", profileDirectory: "/x", profilePath: "/x/p.json", version: 1 };
const done = (text: string): TrialWake => ({ state: "completed", acceptanceId: "a", executionId: "e", code: null, text, usage: [], transcript: null, requestToolCalls: [[]], failure: null });

/**
 * A fake organization whose compile output holds the prompt and one skill file, digested the real way, and whose
 * article is the prompt plus a counter: a replayed trial is recognisable by its stale counter.
 */
const world = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-trial-cache-"));
  const state = { boots: 0, skill: "skill v1", state: "completed" as TrialWake["state"] };
  const prepare = async (input: TrialOptions): Promise<PreparedTrial> => {
    const out = path.join(input.directory, "out");
    await mkdir(path.join(out, "workspace"), { recursive: true });
    await writeFile(path.join(out, "workspace", "AGENTS.md"), input.instructions);
    await writeFile(path.join(out, "workspace", "SKILL.md"), state.skill);
    return { agentId: "a", engines: ["none"], image: "i", runtimeRoot: "/r", digest: await compiledAgentDigest(out, input.trialId),
      dispose: async () => undefined, login: async () => [],
      boot: async (_gateway, options) => {
        const boot = ++state.boots;
        await writeFile(path.join(options.evidenceDirectory, "container.log"), `boot ${boot}`);
        return { container: `c${boot}`, scanCredentials: async () => [],
          read: async () => `${input.instructions} article ${boot}`,
          wake: async (text) => ({ ...done(`${text} reply ${boot}`), state: state.state }),
          teardown: async () => null };
      } };
  };
  const open = (run: string, mode: TrialCacheMode = "reuse") => createBootedTrialRun({
    agentManifestPath: "/nonexistent/Spawnfile", authProfile: profile, scratchRoot: path.join(root, run), prepare: prepare as never, docker: async () => "",
    cache: { mode, store: openTrialCacheStore(path.join(root, "cache"), path.join(root, run, "claims.jsonl")) }
  });
  const trial = async (run: ReturnType<typeof open>, trialId: string, instructions: string) => {
    const evidenceDirectory = path.join(root, "evidence", trialId);
    await mkdir(evidenceDirectory, { recursive: true });
    const booted = await run.boot({ trialId, instructions, moment: { at: "2026-10-05" }, evidenceDirectory });
    const wake = await booted.wake("go", { deliveryId: "d", timeoutMs: 1000 });
    const article = await booted.read("article.md");
    await booted.teardown();
    return { wake, article, evidence: evidenceDirectory };
  };
  return { open, root, state, trial };
};

it("replays an identical trial in a later run without booting, and says which trial measured it", async () => {
  const { open, state, trial } = await world();
  const first = await trial(open("run-1"), "t1", "prompt v1");
  expect(state.boots).toBe(1);
  const again = await trial(open("run-2"), "t2", "prompt v1");
  expect(state.boots).toBe(1);
  expect(again.wake).toEqual({ ...first.wake, reusedFrom: "t1" });
  expect(again.article).toBe(first.article);
  expect(await readFile(path.join(again.evidence, "container.log"), "utf8")).toBe("boot 1");
  expect(JSON.parse(await readFile(path.join(again.evidence, "reused-from.json"), "utf8"))).toMatchObject({ trialId: "t1" });
});

it("never serves a changed prompt file or a changed skill file from the cache", async () => {
  const { open, state, trial } = await world();
  await trial(open("run-1"), "t1", "prompt v1");
  const changed = await trial(open("run-2"), "t2", "prompt v1, one word changed");
  expect(state.boots).toBe(2);
  expect(changed.wake.reusedFrom).toBeUndefined();
  expect(changed.article).toBe("prompt v1, one word changed article 2");
  state.skill = "skill v2";
  const skill = await trial(open("run-3"), "t3", "prompt v1");
  expect(state.boots).toBe(3);
  expect(skill.wake.reusedFrom).toBeUndefined();
});

it("counts one recorded trial once per run: a repeat in the same run, or after a resume, runs fresh", async () => {
  const { open, state, trial } = await world();
  const run = open("run-1");
  await trial(run, "t1", "p");
  await trial(run, "t2", "p");
  expect(state.boots).toBe(2);
  const later = open("run-2");
  const [one, two] = [await trial(later, "t3", "p"), await trial(later, "t4", "p")];
  expect([one.wake.reusedFrom, two.wake.reusedFrom]).toEqual(["t1", "t2"]);
  expect(state.boots).toBe(2);
  // The same run reopened (a resume) keeps its claims: both entries are spent, so the next trial boots.
  const resumed = open("run-2");
  expect((await trial(resumed, "t5", "p")).wake.reusedFrom).toBeUndefined();
  expect(state.boots).toBe(3);
});

it("runs every trial fresh on request, still recording; never records a failed turn", async () => {
  const { open, state, trial } = await world();
  await trial(open("run-1"), "t1", "p");
  await trial(open("run-2", "fresh"), "t2", "p");
  expect(state.boots).toBe(2);
  state.state = "failed";
  await trial(open("run-3"), "t3", "q");
  state.state = "completed";
  await trial(open("run-4"), "t4", "q");
  expect(state.boots).toBe(4);
  // run-1 and the fresh run-2 each recorded one trial of "p".
  const reuse = open("run-5");
  expect([(await trial(reuse, "t5", "p")).wake.reusedFrom, (await trial(reuse, "t6", "p")).wake.reusedFrom]).toEqual(["t1", "t2"]);
});

it("boots without a cache when told off", async () => {
  const { open, state, trial } = await world();
  await trial(open("run-1", "off"), "t1", "p");
  await trial(open("run-2"), "t2", "p");
  expect(state.boots).toBe(2);
});

it("reads a judgment written before the trial files moved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-judgment-key-"));
  try {
    // Frozen hash of the original version, Daimon judge instructions, and request key.
    const recorded = path.join(root, "judgments", "e5c5b8b2db733e5d8b5a65e4196a82354d0c3dc0d6b37f6d6ef5b9dc9b964157");
    await mkdir(recorded, { recursive: true });
    await writeFile(path.join(recorded, "0.json"), JSON.stringify({ reply: "cached before the move" }));
    await expect(openDaimonJudgmentCacheStore(root).take("existing judgment"))
      .resolves.toEqual({ occurrence: 0, reply: "cached before the move" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
