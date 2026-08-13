import {
  SELECTED_TARGET_VERSION,
  parseSelectedTargetReceipt,
  parseTargetResourceRequest,
  type SelectedTargetReceipt,
  type TargetResourceRequest
} from "../target/contracts.js";
import {
  initializeTargetJournal,
  openExistingTargetJournalAuthority,
  type TargetJournalStore
} from "../target/journal.js";

import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import { targetDefaultEnvelope as envelope } from "./targetDefaultEnvelope.js";

export const TARGET_DEFAULT_AUTHORITIES_ERROR = "Target authority initialization failed";
const fail = (): never => { throw new Error(TARGET_DEFAULT_AUTHORITIES_ERROR); };
type MutationRequest = Exclude<TargetResourceRequest, { operation: "select_target" }>;

export interface TargetMutationAuthority {
  readonly journal: TargetJournalStore;
  readonly request: MutationRequest;
  readonly selectedTarget: SelectedTargetReceipt;
}

export interface TargetJournalResolver {
  resolve(input: { readonly context: unknown; readonly request: unknown }): Promise<TargetMutationAuthority>;
}

export interface TargetJournalAccess {
  readonly resolver: TargetJournalResolver;
  resolveIdentity(input: {
    readonly context: unknown;
    readonly descriptorDigest: unknown;
    readonly runId: unknown;
    readonly selectedTarget: unknown;
  }): Promise<TargetJournalStore>;
  resolveExistingIdentity(input: {
    readonly context: unknown;
    readonly descriptorDigest: unknown;
    readonly runId: unknown;
    readonly selectedTarget: unknown;
  }): Promise<TargetJournalStore>;
}

const selectedFrom = (request: MutationRequest): SelectedTargetReceipt =>
  parseSelectedTargetReceipt({
    ...request.selected_target,
    version: SELECTED_TARGET_VERSION
  });

const mutation = (raw: unknown): MutationRequest => {
  let request: TargetResourceRequest;
  try { request = parseTargetResourceRequest(raw); } catch { return fail(); }
  if (request.operation === "select_target") return fail();
  return request;
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const identityKey = (
  context: string,
  request: MutationRequest,
  selected: SelectedTargetReceipt
): string => [
  context,
  request.run_id,
  request.descriptor_digest,
  selected.fingerprint,
  selected.handle
].join("\0");

export const createTargetJournalAccess = (
  config: TargetDefaultConfig
): TargetJournalAccess => {
  const cache = new Map<string, Promise<TargetJournalStore>>();
  const resolveIdentity = async (input: {
    readonly context: unknown;
    readonly descriptorDigest: unknown;
    readonly runId: unknown;
    readonly selectedTarget: unknown;
  }): Promise<TargetJournalStore> => {
    if (input.context !== config.context) return fail();
    let selectedTarget: SelectedTargetReceipt;
    try {
      selectedTarget = parseSelectedTargetReceipt({
        ...(input.selectedTarget as object),
        version: SELECTED_TARGET_VERSION
      });
    } catch { return fail(); }
    const synthetic = {
      descriptor_digest: input.descriptorDigest,
      run_id: input.runId,
      selected_target: {
        fingerprint: selectedTarget.fingerprint,
        handle: selectedTarget.handle
      }
    } as MutationRequest;
    const key = identityKey(config.context, synthetic, selectedTarget);
    let journal = cache.get(key);
    if (!journal) {
      journal = initializeTargetJournal({
        context: config.context,
        descriptorDigest: input.descriptorDigest,
        root: config.paths.journals,
        runId: input.runId,
        selectedTarget
      });
      cache.set(key, journal);
      journal.catch(() => { if (cache.get(key) === journal) cache.delete(key); });
    }
    const resolved = await journal;
    const snapshot = await resolved.read();
    if (snapshot.run_id !== input.runId
      || snapshot.descriptor_digest !== input.descriptorDigest
      || !same(snapshot.selected_target, synthetic.selected_target)) return fail();
    return resolved;
  };
  const resolveExistingIdentity = async (input: {
    readonly context: unknown;
    readonly descriptorDigest: unknown;
    readonly runId: unknown;
    readonly selectedTarget: unknown;
  }): Promise<TargetJournalStore> => {
    if (input.context !== config.context) return fail();
    let selectedTarget: SelectedTargetReceipt;
    try {
      selectedTarget = parseSelectedTargetReceipt({
        ...(input.selectedTarget as object),
        version: SELECTED_TARGET_VERSION
      });
    } catch { return fail(); }
    const synthetic = {
      descriptor_digest: input.descriptorDigest,
      run_id: input.runId,
      selected_target: { fingerprint: selectedTarget.fingerprint, handle: selectedTarget.handle }
    } as MutationRequest;
    let resolved: TargetJournalStore;
    try {
      resolved = await openExistingTargetJournalAuthority({
        context: config.context,
        descriptorDigest: input.descriptorDigest,
        root: config.paths.journals,
        runId: input.runId,
        selectedTarget
      });
    } catch { return fail(); }
    const snapshot = await resolved.read();
    if (snapshot.run_id !== input.runId
      || snapshot.descriptor_digest !== input.descriptorDigest
      || !same(snapshot.selected_target, synthetic.selected_target)) return fail();
    return resolved;
  };
  const resolver: TargetJournalResolver = Object.freeze({
    resolve: async (raw: { readonly context: unknown; readonly request: unknown }) => {
      const input = envelope(raw, ["context", "request"]);
      if (input.context !== config.context) return fail();
      const request = mutation(input.request);
      const selectedTarget = selectedFrom(request);
      if (!same(request.selected_target, {
        fingerprint: selectedTarget.fingerprint,
        handle: selectedTarget.handle
      })) return fail();
      const resolved = await resolveIdentity({
        context: input.context,
        descriptorDigest: request.descriptor_digest,
        runId: request.run_id,
        selectedTarget: request.selected_target
      });
      return Object.freeze({ journal: resolved, request, selectedTarget });
    }
  });
  return { resolver, resolveExistingIdentity, resolveIdentity };
};
