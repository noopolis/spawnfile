import { CAUSAL_EVENT_VERSION } from "@noopolis/stele";
import type { CausalEvent } from "@noopolis/stele";
import { describe, expect, it } from "vitest";

import { runSyntheticConformance } from "./conformance.js";

const eventAtSeq = (seq: number): CausalEvent => ({
  cause_event_ids: [],
  emitter: { seq, stream_id: "network:room-1", system: "moltnet" },
  event_id: `moltnet:m${seq}`,
  payload: { content_sha256: `${seq}`.repeat(64), message_id: `m${seq}` },
  principal_id: "agent:agent-1",
  recorded_at: "2026-07-09T00:00:00.000Z",
  run_id: "run-1",
  type: "message.accepted",
  version: CAUSAL_EVENT_VERSION
});

describe("sequence-gap range diagnostics", () => {
  it("renders a contiguous multi-sequence gap as an inclusive range", () => {
    const jsonl = [eventAtSeq(1), eventAtSeq(5)].map((event) => JSON.stringify(event)).join("\n");

    const report = runSyntheticConformance([{ jsonl, name: "moltnet-fixture" }]);

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      {
        message: "stream run-1/moltnet:network:room-1 has a seq gap at 2-4 (max seq 5)",
        source: "<seq>"
      }
    ]);
  });
});
