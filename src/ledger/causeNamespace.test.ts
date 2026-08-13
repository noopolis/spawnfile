import { describe, expect, it } from "vitest";

import { CAUSAL_EVENT_VERSION, type CausalEvent } from "@noopolis/stele";

import { checkCauseNamespaces } from "./causeNamespace.js";

const eventWithCauses = (causeEventIds: string[]): CausalEvent => ({
  cause_event_ids: causeEventIds,
  emitter: { seq: 1, stream_id: "world", system: "simfile" },
  event_id: "simfile:fixture-event",
  payload: {},
  principal_id: "system:simfile.world",
  recorded_at: "2026-08-01T00:00:00.000Z",
  run_id: "run-cause-namespace",
  type: "clock.sync",
  version: CAUSAL_EVENT_VERSION
});

describe("checkCauseNamespaces", () => {
  it("accepts a conforming recognized cause", () => {
    expect(checkCauseNamespaces([eventWithCauses(["moltnet:fixture-m1"])])).toEqual([]);
  });

  it("accepts a foreign namespace", () => {
    expect(checkCauseNamespaces([eventWithCauses(["driver:turn:7"])])).toEqual([]);
  });

  it("reports a bare cause without mutating or filtering its event", () => {
    const event = eventWithCauses(["fixture-turn-1"]);
    const events = [event];
    const before = structuredClone(events);

    const issues = checkCauseNamespaces(events);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("fixture-turn-1");
    expect(issues[0]?.message).toContain(event.event_id);
    expect(events).toEqual(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
  });

  it("reports only the bad cause among several and names it", () => {
    const issues = checkCauseNamespaces([
      eventWithCauses(["moltnet:fixture-m1", "bare-cause", "driver:turn:7"])
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("bare-cause");
  });

  it("accepts an empty cause list", () => {
    expect(checkCauseNamespaces([eventWithCauses([])])).toEqual([]);
  });
});
