import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runRealConformance, stitchInteractionChain } from "./conformance.js";
import { CAUSAL_EVENT_VERSION, parseCausalJsonl, reconcileEvents, traceCausesBackward } from "@noopolis/stele";
import type { CausalEvent } from "@noopolis/stele";
import { EMITTER_RUN_ID } from "./emitters.js";
import type { EmitterSpec, Exec, ExecResult } from "./emitters.js";

/**
 * Canned real-shaped records, mirroring exactly what the four real B92
 * emitters produce (see each sibling's AGENTS.md / emitCausalFixture/
 * causal_fixture.go): independent ids that do NOT cross-reference each
 * other pre-stitch. These are pure fixtures — no live emitter invocation —
 * used to prove stitchInteractionChain + reconcileEvents without paying the
 * cost (and Docker/Go toolchain dependency) of the real processes. The real
 * end-to-end proof lives in `npm run test:causal-conformance`
 * (causalConformanceCli.ts).
 *
 * Every stamped `principal_id` here is grammar-compliant
 * (`agent:fixture-agent` / `system:simfile.world`, specs/CAUSAL.md §3): as
 * of the B62 fix, `runRealConformance` runs `PRINCIPAL_DISCIPLINE_CHECKS`
 * (principal.ts) over this exact fixture set via `validateConformanceSources`
 * — see the "rejects a bare principal_id" case below for the negative proof.
 */
const m1: CausalEvent = {
  cause_event_ids: [],
  emitter: { seq: 1, stream_id: "network:fixture-network", system: "moltnet" },
  event_id: "moltnet:fixture-m1",
  payload: {
    content_sha256: "a".repeat(64),
    message_id: "fixture-m1",
    policy_decision: "accepted",
    target: { kind: "room", room_id: "fixture-room" }
  },
  principal_id: "agent:fixture-agent",
  recorded_at: "2024-01-01T00:00:00.000Z",
  run_id: EMITTER_RUN_ID,
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION
};

const m2Unstitched: CausalEvent = {
  ...m1,
  cause_event_ids: [],
  emitter: { ...m1.emitter, seq: 2 },
  event_id: "moltnet:fixture-m2",
  payload: { ...m1.payload, content_sha256: "b".repeat(64), message_id: "fixture-m2" },
  recorded_at: "2024-01-01T00:00:01.000Z"
};

const recallAt = (seq: number): CausalEvent => ({
  cause_event_ids: [],
  emitter: { seq, stream_id: "memory:fixture-agent", system: "mneme" },
  event_id: `mneme:r${seq}`,
  payload: { content_sha256: `${seq}`.repeat(64), memory_id: `mem-${seq}`, revision_id: "rev-1", scope: "room" },
  principal_id: "agent:fixture-agent",
  recorded_at: `2024-01-01T00:00:0${seq}.000Z`,
  run_id: EMITTER_RUN_ID,
  type: "memory.recalled",
  version: CAUSAL_EVENT_VERSION
});
const recalls = [recallAt(1), recallAt(2), recallAt(3)];

const t1Unstitched: CausalEvent = {
  // Real daimon fixture stamps cause_event_ids: [turnId] — a bare, un-prefixed
  // local turn id retained ON PURPOSE per B169 D4. It must survive ingest so
  // stitching can replace it; discard-before-stitch is the guarded regression.
  cause_event_ids: ["fixture-turn-1"],
  emitter: { seq: 1, stream_id: "agent:fixture-agent", system: "daimon" },
  event_id: "daimon:fixture-turn-1:turn.input.submitted",
  payload: {
    input_content_sha256: "0".repeat(64),
    input_message_ids: ["fixture-turn-1"],
    prompt_sha256: "p".repeat(64),
    turn_id: "fixture-turn-1"
  },
  principal_id: "agent:fixture-agent",
  recorded_at: "2024-01-01T00:00:04.000Z",
  run_id: EMITTER_RUN_ID,
  type: "turn.input.submitted",
  version: CAUSAL_EVENT_VERSION
};

const t1out: CausalEvent = {
  // Real daimon does cause turn.output.completed from its own turn.input.submitted for real.
  cause_event_ids: [t1Unstitched.event_id],
  emitter: { seq: 2, stream_id: "agent:fixture-agent", system: "daimon" },
  event_id: "daimon:fixture-turn-1:turn.output.completed",
  payload: { output_sha256: "o".repeat(64), turn_id: "fixture-turn-1" },
  principal_id: "agent:fixture-agent",
  recorded_at: "2024-01-01T00:00:05.000Z",
  run_id: EMITTER_RUN_ID,
  type: "turn.output.completed",
  version: CAUSAL_EVENT_VERSION
};

const unstitchedChain = [m1, m2Unstitched, ...recalls, t1Unstitched, t1out];

describe("stitchInteractionChain", () => {
  it("admits the real bare T1 cause through parsing so it reaches stitching", () => {
    const { errors, events } = parseCausalJsonl(toJsonl([t1Unstitched, t1out]));
    expect(errors).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.event_id === t1Unstitched.event_id)?.cause_event_ids)
      .toEqual(["fixture-turn-1"]);
  });

  it("rewrites only cause_event_ids/input_message_ids/input_content_sha256, byte-identical otherwise", () => {
    const { issues, stitched } = stitchInteractionChain(unstitchedChain);
    expect(issues).toEqual([]);

    const stitchedM1 = stitched.find((event) => event.event_id === "moltnet:fixture-m1");
    expect(stitchedM1).toEqual(m1);

    const stitchedM2 = stitched.find((event) => event.event_id === "moltnet:fixture-m2");
    expect(stitchedM2?.cause_event_ids).toEqual([t1out.event_id]);
    expect({ ...stitchedM2, cause_event_ids: [] }).toEqual({ ...m2Unstitched, cause_event_ids: [] });

    for (const recall of recalls) {
      const stitchedRecall = stitched.find((event) => event.event_id === recall.event_id);
      expect(stitchedRecall?.cause_event_ids).toEqual([m1.event_id]);
      expect({ ...stitchedRecall, cause_event_ids: [] }).toEqual({ ...recall, cause_event_ids: [] });
    }

    const stitchedT1 = stitched.find((event) => event.event_id === t1Unstitched.event_id);
    expect(stitchedT1?.cause_event_ids).toEqual([m1.event_id, ...recalls.map((recall) => recall.event_id)]);
    expect(t1Unstitched.cause_event_ids).toEqual(["fixture-turn-1"]);
    expect(stitchedT1?.payload.input_message_ids).toEqual([m1.payload.message_id]);
    expect(stitchedT1?.payload.input_content_sha256).toBe(m1.payload.content_sha256);
    expect({
      ...stitchedT1,
      cause_event_ids: [],
      payload: { ...stitchedT1?.payload, input_content_sha256: "", input_message_ids: [] }
    }).toEqual({
      ...t1Unstitched,
      cause_event_ids: [],
      payload: { ...t1Unstitched.payload, input_content_sha256: "", input_message_ids: [] }
    });

    const stitchedT1out = stitched.find((event) => event.event_id === t1out.event_id);
    expect(stitchedT1out).toEqual(t1out);
  });

  it("reports an issue (not a throw) for each missing role instead of guessing", () => {
    const withoutRecalls = unstitchedChain.filter((event) => event.emitter.system !== "mneme");
    const { issues, stitched } = stitchInteractionChain(withoutRecalls);

    expect(issues).toEqual([
      { message: expect.stringContaining("missing mneme memory.recalled"), source: "<chain>" }
    ]);
    expect(stitched).toEqual(withoutRecalls);
  });

  it("reports an issue when a real turn.output.completed does not actually cause from its turn.input.submitted", () => {
    const brokenT1out: CausalEvent = { ...t1out, cause_event_ids: ["some:other-event"] };
    const events = unstitchedChain.map((event) => (event.event_id === t1out.event_id ? brokenT1out : event));

    const { issues } = stitchInteractionChain(events);

    expect(issues).toEqual([
      { message: expect.stringContaining("expected daimon turn.output.completed to cause from"), source: "<chain>" }
    ]);
  });
});

describe("stitchInteractionChain + reconcileEvents — full B92 chain", () => {
  it("reconciles all chain nodes complete and reproduces the exact backward trace from M2, for any R count", () => {
    const { issues, stitched } = stitchInteractionChain(unstitchedChain);
    expect(issues).toEqual([]);

    const result = reconcileEvents(stitched);
    for (const event of stitched) {
      expect(result.byEventId.get(event.event_id)?.state).toBe("complete");
    }

    const edges = traceCausesBackward(result, m2Unstitched.event_id);
    // Each R also causes from M1 post-stitch, so the DFS revisits M1's
    // (already-visited) edge target once per R, per traceCausesBackward's
    // documented depth-first order.
    const expectedEdges = [
      { from: m2Unstitched.event_id, to: t1out.event_id },
      { from: t1out.event_id, to: t1Unstitched.event_id },
      { from: t1Unstitched.event_id, to: m1.event_id },
      ...recalls.flatMap((recall) => [
        { from: t1Unstitched.event_id, to: recall.event_id },
        { from: recall.event_id, to: m1.event_id }
      ])
    ];
    expect(edges).toEqual(expectedEdges);

    // moltnet's own fixture principal is grammar-shaped by construction (never a From field).
    expect(stitched.find((event) => event.event_id === m1.event_id)?.principal_id).toMatch(/^agent:/);
    expect(stitched.find((event) => event.event_id === m2Unstitched.event_id)?.principal_id).toMatch(/^agent:/);
    // Every role's principal is a real authenticated identity, never derived from payload/model output.
    for (const event of stitched) {
      expect(event.principal_id.length).toBeGreaterThan(0);
    }
  });

  it("marks M2 partial when turn.output.completed is dropped after stitching", () => {
    const { stitched } = stitchInteractionChain(unstitchedChain);
    const droppedOutput = stitched.filter((event) => event.event_id !== t1out.event_id);

    const result = reconcileEvents(droppedOutput);

    expect(result.byEventId.get(m2Unstitched.event_id)?.state).toBe("partial");
  });

  it("marks a reintroduced turn.output.completed divergent when its content hash differs", () => {
    const { stitched } = stitchInteractionChain(unstitchedChain);
    const conflicting: CausalEvent = {
      ...t1out,
      payload: { ...t1out.payload, output_sha256: "f".repeat(64) }
    };

    const result = reconcileEvents([...stitched, conflicting]);

    expect(result.byEventId.get(t1out.event_id)?.state).toBe("divergent");
    expect(result.occurrencesByEventId.get(t1out.event_id)).toHaveLength(2);
  });
});

const toExecResult = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  exitCode: 0,
  stderr: "",
  stdout: "",
  timedOut: false,
  ...overrides
});

const toJsonl = (events: CausalEvent[]): string => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

const simfileClockSyncEvent: CausalEvent = {
  cause_event_ids: [],
  emitter: { seq: 1, stream_id: "world", system: "simfile" },
  event_id: "simfile:clock-1",
  payload: {},
  principal_id: "system:simfile.world",
  recorded_at: "2024-01-01T00:00:00.000Z",
  run_id: EMITTER_RUN_ID,
  type: "clock.sync",
  version: CAUSAL_EVENT_VERSION
};

describe("runRealConformance", () => {
  const tempDirs: string[] = [];

  const completeExec = async (
    simfileEvent: CausalEvent = simfileClockSyncEvent,
    moltnetEvents: CausalEvent[] = [m1, m2Unstitched]
  ): Promise<Exec> => {
    const daimonDir = await mkdtemp(path.join(os.tmpdir(), "noopolis-real-conformance-test-"));
    tempDirs.push(daimonDir);
    const daimonJsonlPath = path.join(daimonDir, "causal.jsonl");
    await writeFile(daimonJsonlPath, toJsonl([t1Unstitched, t1out]), "utf8");

    const bySource: Record<string, ExecResult> = {
      daimon: toExecResult({ stdout: `${daimonJsonlPath}\n` }),
      mneme: toExecResult({ stdout: toJsonl(recalls) }),
      moltnet: toExecResult({ stdout: toJsonl(moltnetEvents) }),
      simfile: toExecResult({ stdout: toJsonl([simfileEvent]) })
    };
    return async (spec: EmitterSpec): Promise<ExecResult> => bySource[spec.name] ?? toExecResult();
  };

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("collects, validates, stitches, and reconciles across 4 fake-exec'd sources end to end", async () => {
    const report = await runRealConformance({ exec: await completeExec() });

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.sourceCounts).toEqual(
      expect.arrayContaining([
        { count: 2, source: "moltnet" },
        { count: 3, source: "mneme" },
        { count: 2, source: "daimon" },
        { count: 1, source: "simfile" }
      ])
    );
    expect(report.chain.edges).toEqual([
      { from: m2Unstitched.event_id, to: t1out.event_id },
      { from: t1out.event_id, to: t1Unstitched.event_id },
      { from: t1Unstitched.event_id, to: m1.event_id },
      ...recalls.flatMap((recall) => [
        { from: t1Unstitched.event_id, to: recall.event_id },
        { from: recall.event_id, to: m1.event_id }
      ])
    ]);
  });

  it("retains a foreign-namespace cause unchanged end to end", async () => {
    const foreignCauseEvent: CausalEvent = {
      ...simfileClockSyncEvent,
      cause_event_ids: ["driver:turn:7"],
      event_id: "simfile:clock-foreign"
    };
    const report = await runRealConformance({ exec: await completeExec(foreignCauseEvent) });

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.events.find((event) => event.event_id === foreignCauseEvent.event_id)?.cause_event_ids)
      .toEqual(["driver:turn:7"]);
  });

  it("reports an unrepaired bare cause while retaining its carrying event", async () => {
    const bareCauseEvent: CausalEvent = {
      ...simfileClockSyncEvent,
      cause_event_ids: ["bare-unrepaired"],
      event_id: "simfile:clock-bare"
    };
    const report = await runRealConformance({ exec: await completeExec(bareCauseEvent) });

    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes("bare-unrepaired"))).toBe(true);
    expect(report.events.find((event) => event.event_id === bareCauseEvent.event_id)?.cause_event_ids)
      .toEqual(["bare-unrepaired"]);
  });

  it("reports the failing source as an issue (never a silent skip) when one real emitter fails", async () => {
    const exec = async (spec: EmitterSpec): Promise<ExecResult> =>
      spec.name === "moltnet"
        ? toExecResult({ exitCode: 1, stderr: "go build failed" })
        : spec.name === "mneme"
          ? toExecResult({ stdout: toJsonl(recalls) })
          : toExecResult();

    const report = await runRealConformance({ exec });

    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.source === "moltnet" && issue.message.includes("exited with code 1"))).toBe(true);
    // Missing moltnet means the chain can't be stitched (missing M1/M2); reported, not thrown.
    expect(report.chain.issues.length).toBeGreaterThan(0);
  });

  /**
   * B62 fix proof (T4): before conformance.ts:361 passed
   * PRINCIPAL_DISCIPLINE_CHECKS into runRealConformance's shared
   * validateConformanceSources call, the real `npm run test:causal-conformance`
   * path was blind to principal grammar — a real sibling emitter stamping a
   * non-authenticated principal_id would pass conformance silently. These two
   * cases exercise the exact function the CLI runs (runRealConformance) and
   * prove it now reports an issue instead.
   */
  it("reports a conformance issue when a real emitter stamps a bare (ungrammatical) principal_id", async () => {
    const badPrincipalM1: CausalEvent = { ...m1, principal_id: "alice" };
    const report = await runRealConformance({
      exec: await completeExec(simfileClockSyncEvent, [badPrincipalM1, m2Unstitched])
    });

    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (issue) => issue.source === "moltnet" && issue.message.toLowerCase().includes("principal_id")
      )
    ).toBe(true);
  });

  it("reports a conformance issue when a real emitter stamps moltnet's anonymous placeholder principal (schema-valid, caught by PRINCIPAL_DISCIPLINE_CHECKS)", async () => {
    // "system:moltnet.anonymous" satisfies PRINCIPAL_GRAMMAR_SOURCE (it IS a
    // real `system:` principal) so it passes envelope.ts's schema regex —
    // only checkPrincipalGrammar (principal.ts), reached via
    // PRINCIPAL_DISCIPLINE_CHECKS, rejects it as unauthenticated. This is
    // the case that specifically proves conformance.ts:361's wiring, not
    // just the envelope.ts regex.
    const anonymousM1: CausalEvent = { ...m1, principal_id: "system:moltnet.anonymous" };
    const report = await runRealConformance({
      exec: await completeExec(simfileClockSyncEvent, [anonymousM1, m2Unstitched])
    });

    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (issue) => issue.source === "moltnet" && issue.message.includes("not an authenticated")
      )
    ).toBe(true);
  });
});
