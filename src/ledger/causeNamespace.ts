import { parseCausalCauseId, type CausalEvent } from "@noopolis/stele";

import type { ConformanceIssue } from "./conformance.js";

/**
 * Reports B169 D4 cause-namespace violations without throwing, filtering, or
 * mutating events. Real conformance calls this only after chain stitching has
 * had its chance to repair producer-local bare causes.
 */
export const checkCauseNamespaces = (
  events: readonly CausalEvent[],
  sourceName = "<cause-namespace>"
): ConformanceIssue[] => {
  const issues: ConformanceIssue[] = [];

  for (const event of events) {
    for (const causeId of event.cause_event_ids) {
      try {
        parseCausalCauseId(causeId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        issues.push({
          message: `event ${event.event_id} has nonconforming cause id ${JSON.stringify(causeId)}: ${reason}`,
          source: sourceName
        });
      }
    }
  }

  return issues;
};
