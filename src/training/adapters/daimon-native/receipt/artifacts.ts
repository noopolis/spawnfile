import { join } from 'node:path';
import { isGrokLaunch, type NativeLaunch } from './schema.js';
import { sha256 } from './paths.js';

/** Fixed name of the Grok control-root subtree Paideia owns; everything else under a slot control root belongs to Daimon or the container. */
export const grokTrialArtifactsDirectory = 'paideia-trials';

/**
 * Where one trial's private control artifacts live.
 *
 * Codex: the control root itself. Preparation creates a fresh empty control
 * directory per trial inside that trial's runtime home, so nothing is ever
 * shared and `wx` writes cannot collide.
 *
 * Grok: the broker-capable training container fixes the control root at a slot
 * path (`/run/training/slot/state`) whose mask is what the projection digest
 * binds, and Daimon's own wake-acceptance store already lives inside it. The
 * container cannot move it without changing `projection_sha256`, and the slot
 * supervisor's recycle only wipes Daimon's store, so the control root is
 * neither empty nor per-trial. Paideia therefore owns exactly one subtree of
 * it and separates trials inside that subtree itself: the directory is created
 * once, non-recursively, so a repeated trial identity fails instead of
 * overwriting or colliding with the previous trial's `wx` artifacts. The leaf
 * name is a digest of the trial identity, so a caller-supplied identity can
 * never escape the control root or collide with `paideia-trials` itself.
 */
export function nativeTrialArtifactsRoot(launch: NativeLaunch, trialId: string): string {
  if (!isGrokLaunch(launch)) return launch.controlRoot;
  return join(launch.controlRoot, grokTrialArtifactsDirectory, `trial-${sha256(trialId).slice(0, 32)}`);
}
