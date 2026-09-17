import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GrokSlotFreshnessStore } from './slot-freshness.js';
import { grokSubjectRoots, nativeTrialArtifactsRoot, parseGrokBrokerReceipt, readPrivateFile, requiredGrokEvaluatorPaths,
  type GrokNativeLaunch, type VerifiedNativeLaunch } from '../receipt/index.js';

/**
 * Grok slot isolation is proven by the root slot supervisor's receipt, which
 * the worker already verified with Daimon's verifier. The parent re-binds it
 * without Daimon and adds the caller's protected paths: each one, every launch
 * evaluator root and the control root must be an exact denied canary. The two
 * digest-bound subject roots are the one exemption, for the reason
 * `grokSubjectRoots` states; a protected path inside them is still required. No local
 * `codex sandbox` process runs and no model is called. The receipt must carry
 * this trial's recycle nonce and a generation above the last one the
 * evaluator's persisted freshness state accepted; acceptance advances that state.
 */
export async function verifyChildGrokSlot(launch: VerifiedNativeLaunch & GrokNativeLaunch, trialId: string, protectedPaths: readonly string[],
  slots: GrokSlotFreshnessStore | undefined): Promise<void> {
  try {
    if (!slots) throw new Error('Grok child execution requires the evaluator slot freshness store');
    for (const path of protectedPaths) {
      const entry = await lstat(path);
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Unsupported protected native path');
    }
    const subject = grokSubjectRoots(launch);
    const required = protectedPaths.filter(path => !subject.includes(path));
    const artifacts = nativeTrialArtifactsRoot(launch, trialId);
    const receipt = parseGrokBrokerReceipt(JSON.parse(await readPrivateFile(join(artifacts, 'sandbox-projection.json'), 1_048_576)),
      launch, trialId, required);
    await slots.accept(receipt.projection.slot, receipt.slotPreflight);
    await writeFile(join(artifacts, 'child-sandbox-preflight.json'), JSON.stringify({ schema: 'paideia.daimon-native.child-grok-slot-preflight.v1',
      trialId, configSha256: launch.configSha256, projectionSha256: receipt.projectionSha256, slot: receipt.projection.slot,
      workerUid: receipt.projection.workerUid, slotPreflightCreatedAt: receipt.slotPreflight.created_at, slotGeneration: receipt.slotPreflight.generation, modelCallsMade: 0, localSandboxProbe: false,
      evaluatorPathsDenied: [...new Set([...requiredGrokEvaluatorPaths(launch), ...required])].sort() }), { flag: 'wx', mode: 0o600 });
  } catch (error) { throw new Error('Grok broker slot preflight failed before cognition', { cause: error }); }
}
