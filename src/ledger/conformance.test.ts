import { describe, expect, it } from "vitest";

import { DEFAULT_PAYLOAD_MINIMUMS, runSyntheticConformance } from "./conformance.js";
import { CAUSAL_EVENT_VERSION } from "@noopolis/stele";
import type { CausalEvent } from "@noopolis/stele";

const toJsonl = (events: unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n");

const baseEvent: CausalEvent = {
  cause_event_ids: [],
  emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" },
  event_id: "moltnet:m1",
  payload: { content_sha256: "a".repeat(64), message_id: "m1" },
  principal_id: "agent:agent-1",
  recorded_at: "2026-07-09T00:00:00.000Z",
  run_id: "run-1",
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION
};

const worldActPayload = {
  act_id: "act-1",
  action: "moltnet:message",
  actor: "agent-1",
  provenance: "rule:announce",
  scope: "room:office-floor:case-warroom",
  sim_time: "0001-01-01T00:01:00.000Z",
  target: "room:office-floor:case-warroom",
  value: null
};

describe("runSyntheticConformance", () => {
  it("passes for a clean seeded fixture", () => {
    const report = runSyntheticConformance([{ jsonl: toJsonl([baseEvent]), name: "moltnet-fixture" }]);

    expect(report.ok).toBe(true);
    expect(report.eventCount).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it("fails and reports when no sources are provided", () => {
    const report = runSyntheticConformance([]);

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      { message: "no conformance fixture sources were provided", source: "<none>" }
    ]);
  });

  it("reports a line-numbered schema failure without silently dropping the source", () => {
    const report = runSyntheticConformance([
      { jsonl: `${JSON.stringify(baseEvent)}\nnot-json\n`, name: "moltnet-fixture" }
    ]);

    expect(report.ok).toBe(false);
    expect(report.eventCount).toBe(1);
    expect(report.issues).toEqual([
      { line: 2, message: expect.stringContaining("invalid JSON"), source: "moltnet-fixture" }
    ]);
  });

  it("rejects a stream with a seq gap", () => {
    const second: CausalEvent = {
      ...baseEvent,
      emitter: { ...baseEvent.emitter, seq: 3 },
      event_id: "moltnet:m2",
      payload: { content_sha256: "b".repeat(64), message_id: "m2" }
    };

    const report = runSyntheticConformance([
      { jsonl: toJsonl([baseEvent, second]), name: "moltnet-fixture" }
    ]);

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      {
        message: expect.stringContaining("has a seq gap at 2"),
        source: "<seq>"
      }
    ]);
  });

  it.each(DEFAULT_PAYLOAD_MINIMUMS)(
    "rejects $type when a required payload key is missing",
    (minimum) => {
      const [firstKey] = minimum.requiredKeys;
      const payload = Object.fromEntries(
        minimum.requiredKeys.filter((key) => key !== firstKey).map((key) => [key, "x"])
      );

      const event: CausalEvent = {
        ...baseEvent,
        emitter: { seq: 1, stream_id: "test-stream", system: "moltnet" },
        event_id: "moltnet:test",
        payload,
        type: minimum.type
      };

      const report = runSyntheticConformance([{ jsonl: toJsonl([event]), name: "fixture" }]);

      expect(report.ok).toBe(false);
      expect(
        report.issues.some((issue) => issue.message.includes(firstKey!) && issue.message.includes(minimum.type))
      ).toBe(true);
    }
  );

  it("rejects world.message when act_id specifically is missing", () => {
    const { act_id: _actId, ...payloadWithoutActId } = worldActPayload;
    const event: CausalEvent = {
      ...baseEvent,
      emitter: { seq: 1, stream_id: "world", system: "simfile" },
      event_id: "simfile:evt-1",
      payload: payloadWithoutActId,
      type: "world.message"
    };

    const report = runSyntheticConformance([{ jsonl: toJsonl([event]), name: "simfile-fixture" }]);

    expect(report.ok).toBe(false);
    expect(
      report.issues.some((issue) => issue.message.includes("act_id") && issue.message.includes("world.message"))
    ).toBe(true);
  });

  it("passes wake.recommended when value is explicitly null (absent, not null, is the violation)", () => {
    const event: CausalEvent = {
      ...baseEvent,
      emitter: { seq: 1, stream_id: "world", system: "simfile" },
      event_id: "simfile:evt-2",
      payload: { ...worldActPayload, value: null },
      type: "wake.recommended"
    };

    const report = runSyntheticConformance([{ jsonl: toJsonl([event]), name: "simfile-fixture" }]);

    expect(report.ok).toBe(true);
  });

  it("does not flag payload keys for event types with no declared minimum", () => {
    const event: CausalEvent = { ...baseEvent, payload: {}, type: "diagnostic.note" };

    const report = runSyntheticConformance([{ jsonl: toJsonl([event]), name: "fixture" }]);

    expect(report.ok).toBe(true);
  });

  it("aggregates events and issues across multiple sources", () => {
    const moltnetEvent = baseEvent;
    const daimonEvent: CausalEvent = {
      cause_event_ids: ["moltnet:m1"],
      emitter: { seq: 1, stream_id: "agent:agent-1", system: "daimon" },
      event_id: "daimon:t1-in",
      payload: {
        input_content_sha256: "a".repeat(64),
        input_message_ids: ["m1"],
        prompt_sha256: "p".repeat(64),
        turn_id: "t1"
      },
      principal_id: "agent:agent-1",
      recorded_at: "2026-07-09T00:00:01.000Z",
      run_id: "run-1",
      type: "turn.input.submitted",
      version: CAUSAL_EVENT_VERSION
    };

    const report = runSyntheticConformance([
      { jsonl: toJsonl([moltnetEvent]), name: "moltnet-fixture" },
      { jsonl: toJsonl([daimonEvent]), name: "daimon-fixture" }
    ]);

    expect(report.ok).toBe(true);
    expect(report.eventCount).toBe(2);
  });
});

describe("B62 principal discipline (runSyntheticConformance)", () => {
  it.each(["agent:agent-1", "operator:control", "system:simfile.world"])(
    "accepts an authenticated principal_id %s",
    (principalId) => {
      const event: CausalEvent = { ...baseEvent, principal_id: principalId };

      const report = runSyntheticConformance([{ jsonl: toJsonl([event]), name: "fixture" }]);

      expect(report.ok).toBe(true);
    }
  );

  // B62: principal_id is grammar-enforced by envelope.ts's schema itself
  // (PRINCIPAL_GRAMMAR_SOURCE), so a bare id / unrecognized prefix is now
  // rejected at the parseCausalJsonl layer before it ever reaches
  // checkPrincipalGrammar — still `report.ok === false`, just via a
  // schema-parse issue rather than a "not an authenticated" message.
  it.each([
    ["agent-1", "a bare id with no prefix"],
    ["anonymous", "the literal anonymous"],
    ["moltnet:authn:agent-1", "an unrecognized kind prefix"]
  ])("rejects grammar-invalid principal_id %s (%s) at the schema layer", (principalId) => {
    const event: CausalEvent = { ...baseEvent, principal_id: principalId };

    const report = runSyntheticConformance([{ jsonl: toJsonl([event]), name: "fixture" }]);

    expect(report.ok).toBe(false);
  });

  // "system:moltnet.anonymous" IS grammar-valid (a real system: principal),
  // so it passes the schema and reaches checkPrincipalGrammar
  // (PRINCIPAL_DISCIPLINE_CHECKS), which rejects it specifically as
  // moltnet's unauthenticated dev-mode placeholder.
  it("rejects moltnet's anonymous placeholder principal via the grammar-discipline check", () => {
    const event: CausalEvent = { ...baseEvent, principal_id: "system:moltnet.anonymous" };

    const report = runSyntheticConformance([{ jsonl: toJsonl([event]), name: "fixture" }]);

    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (issue) => issue.message.includes(event.event_id) && issue.message.includes("not an authenticated")
      )
    ).toBe(true);
  });

  it("rejects a daimon turn event whose principal_id does not match its agent: stream", () => {
    const spoofedTurnInput: CausalEvent = {
      cause_event_ids: [],
      emitter: { seq: 1, stream_id: "agent:mapper", system: "daimon" },
      event_id: "daimon:t1:turn.input.submitted",
      payload: {
        input_content_sha256: "a".repeat(64),
        input_message_ids: ["m1"],
        prompt_sha256: "p".repeat(64),
        turn_id: "t1"
      },
      // A different (still grammar-valid) agent claims mapper's turn.
      principal_id: "agent:attacker",
      recorded_at: "2026-07-09T00:00:00.000Z",
      run_id: "run-1",
      type: "turn.input.submitted",
      version: CAUSAL_EVENT_VERSION
    };

    const report = runSyntheticConformance([{ jsonl: toJsonl([spoofedTurnInput]), name: "daimon-fixture" }]);

    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (issue) =>
          issue.message.includes("agent:mapper") &&
          issue.message.includes("agent:attacker") &&
          issue.message.includes("must be attributed to the agent that owns their stream")
      )
    ).toBe(true);
  });

  it("does not flag a control-wake event's operator: principal against its agent: stream (intentional mismatch)", () => {
    const controlWakeAccepted: CausalEvent = {
      cause_event_ids: [],
      emitter: { seq: 1, stream_id: "agent:mapper", system: "daimon" },
      event_id: "daimon:req-1:control.wake.accepted",
      payload: { target_agent_id: "mapper", wake_kind: "message" },
      principal_id: "operator:control",
      recorded_at: "2026-07-09T00:00:00.000Z",
      run_id: "run-1",
      type: "control.wake.accepted",
      version: CAUSAL_EVENT_VERSION
    };

    const report = runSyntheticConformance([{ jsonl: toJsonl([controlWakeAccepted]), name: "daimon-fixture" }]);

    expect(report.ok).toBe(true);
  });

  it("fails a hand-built fixture carrying anonymous, a bare id, and a stream/principal mismatch together", () => {
    const anonymous: CausalEvent = {
      ...baseEvent,
      event_id: "moltnet:anon",
      principal_id: "system:moltnet.anonymous"
    };
    const bareId: CausalEvent = { ...baseEvent, event_id: "moltnet:bare", principal_id: "agent-1" };
    const mismatched: CausalEvent = {
      cause_event_ids: [],
      emitter: { seq: 1, stream_id: "agent:mapper", system: "daimon" },
      event_id: "daimon:t2:turn.output.completed",
      payload: { output_sha256: "o".repeat(64), turn_id: "t2" },
      principal_id: "agent:someone-else",
      recorded_at: "2026-07-09T00:00:00.000Z",
      run_id: "run-1",
      type: "turn.output.completed",
      version: CAUSAL_EVENT_VERSION
    };

    const report = runSyntheticConformance([
      { jsonl: toJsonl([anonymous, bareId, mismatched]), name: "bad-fixture" }
    ]);

    expect(report.ok).toBe(false);
    expect(report.issues.length).toBeGreaterThanOrEqual(3);
  });

  it.each(["message.denied", "memory.write.denied", "control.wake.denied"])(
    "declares a payload minimum for %s",
    (type) => {
      expect(DEFAULT_PAYLOAD_MINIMUMS.some((minimum) => minimum.type === type)).toBe(true);
    }
  );

  it("rejects a message.denied event missing its required denial payload keys", () => {
    const messageDenied: CausalEvent = {
      ...baseEvent,
      event_id: "moltnet:m-denied",
      payload: { reason: "not a member of this room" },
      type: "message.denied"
    };

    const report = runSyntheticConformance([{ jsonl: toJsonl([messageDenied]), name: "fixture" }]);

    expect(report.ok).toBe(false);
    expect(
      report.issues.some(
        (issue) => issue.message.includes("message.denied") && issue.message.includes("target")
      )
    ).toBe(true);
  });

  it("passes real-shaped message.denied / memory.write.denied / control.wake.denied records with full payloads", () => {
    const messageDenied: CausalEvent = {
      cause_event_ids: [],
      emitter: { seq: 1, stream_id: "network:room-1", system: "moltnet" },
      event_id: "moltnet:m-denied",
      payload: {
        content_sha256: "d".repeat(64),
        reason: "not a member of this room",
        target: { kind: "room", room_id: "room-1" }
      },
      principal_id: "agent:agent-1",
      recorded_at: "2026-07-09T00:00:02.000Z",
      run_id: "run-1",
      type: "message.denied",
      version: CAUSAL_EVENT_VERSION
    };
    const memoryWriteDenied: CausalEvent = {
      cause_event_ids: [],
      emitter: { seq: 1, stream_id: "memory:agent-1", system: "mneme" },
      event_id: "mneme:w-denied",
      payload: { reason: "scope not derivable from principal", requested_scope: "agent:other-agent" },
      principal_id: "agent:agent-1",
      recorded_at: "2026-07-09T00:00:03.000Z",
      run_id: "run-1",
      type: "memory.write.denied",
      version: CAUSAL_EVENT_VERSION
    };
    const controlWakeDenied: CausalEvent = {
      cause_event_ids: [],
      emitter: { seq: 1, stream_id: "agent:mapper", system: "daimon" },
      event_id: "daimon:req-1:control.wake.denied",
      payload: { reason: "missing bearer token", target_agent_id: "mapper" },
      principal_id: "operator:control",
      recorded_at: "2026-07-09T00:00:04.000Z",
      run_id: "run-1",
      type: "control.wake.denied",
      version: CAUSAL_EVENT_VERSION
    };

    const report = runSyntheticConformance([
      { jsonl: toJsonl([messageDenied, memoryWriteDenied, controlWakeDenied]), name: "denial-fixture" }
    ]);

    expect(report.ok).toBe(true);
    expect(report.eventCount).toBe(3);
  });
});
