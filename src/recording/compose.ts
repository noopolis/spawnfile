import { deployResourcesAt } from "../deployment/index.js";
import { feedLandingAt } from "../volume/index.js";

import { MOMENT_RECORD_VERSION, type ComposeMomentRecordInput, type MomentRecord } from "./types.js";

const orderedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** Compose only supplied evidence at the turn boundary; this function reads no files or clock. */
export const composeMomentRecord = (input: ComposeMomentRecordInput): MomentRecord => {
  const { row, agent } = input;
  const errors = [...(input.errors ?? [])];
  if (row.agent_id !== agent.nodeId) errors.push(`Wake agent ${row.agent_id} does not match compiled agent ${agent.nodeId}`);
  if (row.error !== undefined) errors.push(`Wake recording: ${row.error}`);
  if (!row.deliveries.length) throw new Error("A wake moment requires at least one delivery");
  const startedAt = row.started_at, started = Date.parse(startedAt);
  if (!Number.isFinite(started)) throw new Error("A wake moment requires a valid started_at");

  const resources: MomentRecord["resources"] = [];
  const deployment = deployResourcesAt(input.deployResources, input.deploymentRecordPath, startedAt, agent.nodeId);
  if (deployment && !deployment.activation_exact) {
    errors.push(`Deployment activation is non-exact${deployment.activation_note ? `: ${deployment.activation_note}` : ""}`);
  }
  for (const resource of [...agent.resources].sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind))) {
    const matches = deployment?.resources.filter((entry) => entry.id === resource.id && entry.kind === resource.kind) ?? [];
    const pin = matches[0];
    if (matches.length !== 1 || !pin) {
      errors.push(`${matches.length ? "Ambiguous" : "Missing"} deployment history for ${resource.kind} resource ${resource.id} at ${startedAt}`);
      continue;
    }
    resources.push(pin.kind === "git"
      ? { id: pin.id, kind: pin.kind, commit: pin.commit, sha256: pin.sha256 }
      : { id: pin.id, kind: pin.kind, sha256: pin.sha256 });
  }

  const feeds: MomentRecord["feeds"] = [];
  for (const id of orderedUnique(agent.feeds)) {
    const history = Object.hasOwn(input.feedLandings, id) ? input.feedLandings[id]! : [];
    const landing = feedLandingAt(history.filter((entry) => entry.resource === id), startedAt);
    if (!landing) { errors.push(`Missing feed history for ${id} at ${startedAt}`); continue; }
    feeds.push({ id, revision: landing.revision, tree: landing.tree, landedAt: landing.landed_at,
      ...(landing.commit === undefined ? {} : { commit: landing.commit }),
      ...(landing.ref === undefined ? {} : { ref: landing.ref }),
      ...(landing.paths === undefined ? {} : { paths: [...landing.paths] }),
      ...(landing.period === undefined ? {} : { period: landing.period }) });
  }

  const memory: MomentRecord["memory"] = [];
  for (const bank of [...agent.memory].sort((a, b) => a.id.localeCompare(b.id) || a.declaredBy.localeCompare(b.declaredBy))) {
    const ledger = bank.ledgerPath === null ? undefined : input.memoryLedgers[bank.ledgerPath];
    if (!ledger || ledger.errors?.length) {
      const reasons = ledger?.errors?.length ? ledger.errors : ["ledger could not be read"];
      errors.push(...reasons.map((reason) => `Memory bank ${bank.id} (${bank.declaredBy}): ${reason}`));
      continue;
    }
    const seq = ledger.entries.reduce((highest, entry) =>
      Date.parse(entry.createdAt) <= started ? Math.max(highest, entry.seq) : highest, 0);
    memory.push({ id: bank.id, declaredBy: bank.declaredBy, seq });
  }

  for (const id of orderedUnique(agent.snapshots)) {
    if (!row.snapshots.some((entry) => entry.id === id)) errors.push(`Missing pre-turn snapshot for ${id}`);
  }
  const messageIds = row.deliveries.flatMap(({ delivery_id }) => {
    const match = /^moltnet:(.+)$/u.exec(delivery_id);
    return match ? [match[1]!] : [];
  });
  return {
    version: MOMENT_RECORD_VERSION, agent: agent.nodeId,
    wake: {
      at: row.deliveries[0]!.occurred_at, startedAt, executionId: row.execution_id,
      deliveries: row.deliveries.map(({ delivery_id, kind, occurred_at }) => ({ deliveryId: delivery_id, kind, occurredAt: occurred_at })),
      ...(messageIds.length ? { surface: "moltnet", messageId: messageIds[0]! } : {})
    },
    recordedAt: input.recordedAt, exact: errors.length === 0, resources, feeds, memory,
    moltnet: orderedUnique(agent.networks).map((network) => ({ network, cursor: startedAt,
      ...(messageIds.length ? { messageIds: [...messageIds] } : {}) })),
    volumes: [...row.snapshots].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, snapshot }) => ({ id, snapshot })),
    ...(errors.length ? { errors } : {})
  };
};
