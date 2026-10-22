import { lstat, realpath } from 'node:fs/promises';
import { grokSlotPreflightSchema, readPrivateFile, type GrokNativeLaunch } from '../receipt/index.js';

/**
 * What the container's own root said about this slot, read before any process starts.
 *
 * A Codex launch anchors every writable root and every control file inside the
 * trial runtime home, a directory the evaluator created for this trial: a launch
 * receipt can therefore never widen writability past the evaluator's own
 * scratch. A Grok launch cannot use that anchor — the training container fixes
 * its slot paths and the projection digest binds them — so the equivalent
 * authority is this receipt. The root slot supervisor writes it after running a
 * worker-uid denial canary over every path in the digest-bound projection, and
 * it names the digest it certifies. Paideia is not that authority, so the file
 * must be root-owned (or, outside a container, owned by this evaluator) and
 * never group- or world-writable.
 *
 * Only the denial set is returned. Receipt freshness stays with the evaluator's
 * slot freshness store, which is the single authority for nonce and generation;
 * the projection v2 digest is checked here because it binds this denial set and
 * the declared workerConfigVariant to this launch. The slot receipt remains v2
 * for both worker variants; launch parsing refuses unclocked task-clock trials.
 */
export async function readGrokSlotDenials(launch: GrokNativeLaunch): Promise<string[]> {
  const file = launch.broker.slotPreflightReceipt;
  if (await realpath(file) !== file) throw new Error('The Grok slot preflight receipt must be a canonical file');
  const entry = await lstat(file);
  const owner = process.getuid?.();
  if ((entry.mode & 0o022) !== 0 || entry.uid !== 0 && entry.uid !== owner) {
    throw new Error('The Grok slot preflight receipt must be written by the container root and stay unwritable to other users');
  }
  const receipt = grokSlotPreflightSchema.parse(JSON.parse(await readPrivateFile(file, 262_144)));
  if (receipt.projection_sha256 !== launch.broker.projectionSha256) {
    throw new Error('The Grok slot preflight receipt certifies a different projection than this launch declares');
  }
  return [...new Set(receipt.canaries.map(canary => canary.path))].sort();
}
