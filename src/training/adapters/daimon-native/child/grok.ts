import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseGrokBrokerReceipt, readPrivateFile, requiredGrokEvaluatorPaths, type GrokNativeLaunch, type VerifiedNativeLaunch } from '../receipt/index.js';

/**
 * Grok slot isolation is proven by the root slot supervisor's receipt, which
 * the worker already verified with Daimon's verifier. The parent re-binds it
 * without Daimon and adds the caller's protected paths: each one, every launch
 * evaluator root and the control root must be an exact denied canary. No local
 * `codex sandbox` process runs and no model is called.
 */
export async function verifyChildGrokSlot(launch: VerifiedNativeLaunch & GrokNativeLaunch, trialId: string, protectedPaths: readonly string[]): Promise<void> {
  try {
    for (const path of protectedPaths) {
      const entry = await lstat(path);
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Unsupported protected native path');
    }
    const receipt = parseGrokBrokerReceipt(JSON.parse(await readPrivateFile(join(launch.controlRoot, 'sandbox-projection.json'), 1_048_576)),
      launch, trialId, protectedPaths);
    await writeFile(join(launch.controlRoot, 'child-sandbox-preflight.json'), JSON.stringify({ schema: 'paideia.daimon-native.child-grok-slot-preflight.v1',
      trialId, configSha256: launch.configSha256, projectionSha256: receipt.projectionSha256, slot: receipt.projection.slot,
      workerUid: receipt.projection.workerUid, slotPreflightCreatedAt: receipt.slotPreflight.created_at, modelCallsMade: 0, localSandboxProbe: false,
      evaluatorPathsDenied: [...new Set([...requiredGrokEvaluatorPaths(launch), ...protectedPaths])].sort() }), { flag: 'wx', mode: 0o600 });
  } catch (error) { throw new Error('Grok broker slot preflight failed before cognition', { cause: error }); }
}
