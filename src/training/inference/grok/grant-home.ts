import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { grokGrantEnvKey, type GrokInferenceGrant, type GrokInferenceGrantAuthority } from '../../contracts/inference-grants.js';
import { InferenceFailure } from '../failure.js';

export interface GrokGrantCall {
  /** Disposable workspace: cwd, HOME and TMPDIR of the CLI. */
  work: string;
  promptFile: string;
  /** Complete child environment. The grant token exists only here. */
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/**
 * A private per-call GROK_HOME (0700, owned by this uid) under a caller-provisioned
 * evaluator root, holding exactly the client config bytes whose sha256 equals the
 * independent pin. Nothing from the ambient HOME, GROK_HOME or API-key variables
 * reaches the child, so a desktop login can never be used instead of the grant.
 */
export async function prepareGrokGrantCall(root: string, authority: GrokInferenceGrantAuthority, grant: GrokInferenceGrant, prompt: string): Promise<GrokGrantCall> {
  const config = authority.renderClientConfig({ baseUrl: grant.baseUrl, model: grant.model, reasoningEffort: grant.reasoningEffort, envKey: authority.envKey });
  const pin = authority.pinnedClientConfigSha256(grant.model, grant.reasoningEffort);
  if (typeof pin !== 'string' || !/^[a-f0-9]{64}$/u.test(pin) || createHash('sha256').update(config).digest('hex') !== pin) {
    throw new InferenceFailure('unsupported', 'Grok broker client configuration does not match its pinned digest');
  }
  // Exactly the key Daimon's renderer declares; any other name means the client config and the child environment disagree.
  if (authority.envKey !== grokGrantEnvKey) throw new InferenceFailure('unsupported', `Grok grant environment key must be ${grokGrantEnvKey}`);
  await privateDirectory(root, 0o022, 'Grok grant home root');
  const dir = await mkdtemp(path.join(root, 'grok-grant-'));
  try {
    await privateDirectory(dir, 0o077, 'Grok grant call directory');
    const home = path.join(dir, 'home'), work = path.join(dir, 'work');
    await mkdir(home, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
    await privateDirectory(home, 0o077, 'Grok grant home'); await privateDirectory(work, 0o077, 'Grok grant workspace');
    await writeFile(path.join(home, 'config.toml'), config, { mode: 0o600, flag: 'wx' });
    const promptFile = path.join(work, 'prompt.txt');
    await writeFile(promptFile, prompt, { mode: 0o600, flag: 'wx' });
    return { work, promptFile, cleanup: () => rm(dir, { recursive: true, force: true }),
      env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: work, TMPDIR: work, GROK_HOME: home, [authority.envKey]: grant.token } };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function privateDirectory(target: string, forbidden: number, label: string): Promise<void> {
  const uid = process.getuid?.();
  let stat;
  try { stat = await lstat(target); } catch { throw new InferenceFailure('unsupported', `${label} is unavailable`); }
  if (!path.isAbsolute(target) || !stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & forbidden) !== 0) {
    throw new InferenceFailure('unsupported', `${label} must be an absolute private directory owned by this user`);
  }
}
