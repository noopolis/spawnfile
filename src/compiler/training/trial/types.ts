import type { UsageRecord } from "../../../runtime/usageLedger.js";
import type { Observation } from "../../../runtime/trainingTypes.js";

export interface TrialWake {
  /** `deferred`: the subject deferred the delivery, or the runtime deferred a failed retry when `failure` is set. */
  state: "completed" | "deferred" | "failed" | "stopped" | "timeout";
  acceptanceId: string;
  executionId: string | null;
  code: string | null;
  text: string;
  /** Usage ledger rows this wake appended; empty means none were written, never zero spend. */
  usage: UsageRecord[];
  /** The engine's own newest session record, bounded; null when none exists. */
  transcript: string | null;
  /** Per model request of this wake, the tool-call names its response carried; null where the runtime could not say. */
  requestToolCalls: (readonly string[] | null)[];
  /** Native evidence before the subject adapter binds it to the current trial and turn. */
  nativeToolEvents?: readonly Omit<Observation, "trialId" | "wakeId">[];
  /** Set only on a replay from the run's trial cache: the trial that measured this wake. */
  reusedFrom?: string;
  /**
   * The engine failure the runtime reported for this delivery, in full, secrets masked: a failed receipt's detail, or
   * the agent's execution error when the delivery did not complete (the runtime deferred it after retrying a failed
   * execution, or its retry was still open at the trial's deadline). Null when none.
   */
  failure: string | null;
}

export interface BootedTrial {
  container: string;
  wake(text: string, options: { deliveryId: string; timeoutMs: number; signal?: AbortSignal }): Promise<TrialWake>;
  /** A workspace-relative file the subject left; null when absent. */
  read(path: string): Promise<string | null>;
  /** Credential-shaped files anywhere in the trial container (expected: none). */
  scanCredentials(): Promise<string[]>;
  /**
   * Saves the container's evidence, then removes it and its volumes. Resolves with the failure its runtime
   * still reported for the agent at that moment (secrets masked), or null: what a turn cut short never returned.
   */
  teardown(): Promise<string | null>;
}
