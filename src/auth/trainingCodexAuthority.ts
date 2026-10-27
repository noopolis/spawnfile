import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveSpawnfileHome } from './paths.js';
import { DAIMON_CODEX_SUBSCRIPTION_REALM } from '../runtime/daimon/contractManifest.js';

/** Stable host state for a declared subscription bootstrap, retained across runs.
 * No credential bytes are copied here; the mounted Daimon authority owns them.
 */
export async function prepareTrainingCodexAuthority(source: string, dockerContext: string): Promise<string> {
  const input = await lstat(source);
  if (await realpath(source) !== path.resolve(source) || !input.isFile() || input.isSymbolicLink() || input.nlink !== 1
    || input.uid !== process.getuid?.() || (input.mode & 0o777) !== 0o600 || input.size < 1
    || input.size > DAIMON_CODEX_SUBSCRIPTION_REALM.maxCredentialBytes) throw new Error('Unsafe training Codex bootstrap');
  const identity = createHash('sha256').update(source).update('\0').update(dockerContext).digest('hex');
  const root = path.join(resolveSpawnfileHome(), 'training', 'subscription-accounts', `codex-${identity}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entry = await lstat(root);
  if (await realpath(root) !== root || !entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || (entry.mode & 0o777) !== 0o700) throw new Error('Unsafe training Codex account state');
  return root;
}

/** Compatibility call for per-trial preparers: validate the one container ingress.
 * It never creates a home-local snapshot or overwrites the rotating authority.
 */
export async function verifyTrainingCodexBootstrap(source: string): Promise<string> {
  const destination = DAIMON_CODEX_SUBSCRIPTION_REALM.bootstrapMountPath;
  const [before, mounted] = await Promise.all([lstat(source), lstat(destination)]);
  for (const entry of [before, mounted]) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid?.()
      || (entry.mode & 0o777) !== 0o600 || entry.size < 1 || entry.size > DAIMON_CODEX_SUBSCRIPTION_REALM.maxCredentialBytes) {
      throw new Error('Training Codex requires its container-owned shared bootstrap');
    }
  }
  if (await realpath(source) !== path.resolve(source) || await realpath(destination) !== destination
    || before.dev !== mounted.dev || before.ino !== mounted.ino) throw new Error('Training Codex bootstrap differs from its declared ingress');
  return destination;
}
