import type { FeedIdentity } from "../../../volume/index.js";
import type { MaterializedInput, MaterializedMoment } from "./contract.js";
import { readFeedLandingHistory, selectFeedLanding } from "./feedLandings.js";
import { historyKey, type History } from "./history.js";
import { compareInstants } from "./instant.js";
import { recordInputErrors } from "./recordInput.js";
import { selectMomentRecord } from "./select.js";

/** Publication metadata can follow the bound only when independent history proves the incoming pin/window. */
export const permitsFeedPublicationTime = async (
  identity: FeedIdentity, input: MaterializedInput, moment: MaterializedMoment, history?: History
): Promise<boolean> => {
  if (!history || identity.landed_at !== input.source.landedAt) return false;
  if (input.basis === "record" && input.fidelity === "exact" && moment.record.matched) {
    const record = selectMomentRecord(await history.records(), moment.agent, moment.at, [input]);
    const pin = record?.feeds.find((entry) => entry.id === input.id);
    return Boolean(record && pin && compareInstants(record.wake.startedAt, moment.effectiveAt) === 0
      && !recordInputErrors(record, input).length && pin.revision === identity.revision
      && pin.tree.replace(/^trees\//u, "") === identity.tree.replace(/^trees\//u, "")
      && pin.commit === input.source.commit && compareInstants(pin.landedAt, identity.landed_at) === 0);
  }
  if (input.basis !== "landing-log" || input.fidelity !== "approximate") return false;
  const selection = selectFeedLanding(await readFeedLandingHistory(history, `feeds/${historyKey(input)}`, input.id) ?? [], moment.effectiveAt);
  const landing = selection?.landing;
  return Boolean(selection?.ambiguous && landing && landing.revision === identity.revision
    && landing.tree.replace(/^trees\//u, "") === identity.tree.replace(/^trees\//u, "")
    && landing.commit === input.source.commit && landing.switching_at === input.source.switchingAt
    && compareInstants(landing.landed_at, identity.landed_at) === 0);
};
