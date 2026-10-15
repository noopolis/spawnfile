import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { nativeChildProbe } from './probe.js';
import { isGrokLaunch, nativeTrialArtifactsRoot, parseNativeSandboxReceipt, readPrivateFile, type VerifiedNativeLaunch } from '../receipt/index.js';
import { verifyChildGrokSlot } from './grok.js';
import type { GrokSlotFreshnessStore } from './slot-freshness.js';

/** Runs the actual owner-produced permission projection, not an approximate test profile. */
export async function verifyChildSandbox(launch: VerifiedNativeLaunch, trialId: string, protectedPaths: readonly string[], signal: AbortSignal,
  grokSlots?: GrokSlotFreshnessStore): Promise<void> {
  if (isGrokLaunch(launch)) return verifyChildGrokSlot(launch, trialId, protectedPaths, grokSlots);
  const home = launch.projections.find(row => row.role === 'home')!.target;
  const artifacts = nativeTrialArtifactsRoot(launch, trialId);
  const receipt = parseNativeSandboxReceipt(JSON.parse(await readPrivateFile(join(artifacts, 'sandbox-projection.json'), 262144)), {
    trialId, configSha256: launch.configSha256, agentId: launch.agent.id, workspacePath: launch.workspace.target, runtimeHomePath: home,
  });
  const scratch = await mkdtemp(join(launch.workspace.target, '.paideia-native-policy-'));
  const owned: string[] = []; const denied: string[] = [];
  const server = createServer(socket => socket.destroy());
  try {
    // An absent configured secret has nothing to deny; the TypeSafe transport refuses it on use.
    const evaluatorSecret = process.env.PAIDEIA_TYPESAFE_SECRET_FILE ? resolve(process.env.PAIDEIA_TYPESAFE_SECRET_FILE) : undefined;
    const secretPresent = evaluatorSecret !== undefined && await lstat(evaluatorSecret).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    for (const path of [...new Set([...protectedPaths, launch.controlRoot, launch.config, launch.tokenFile, launch.envFile,
      ...(secretPresent ? [evaluatorSecret] : [])])]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Unsupported protected native path');
      denied.push(path);
    }
    // Verify the declared auth/ingress rule with canaries only when no credential exists.
    await mkdir(join(home, '.codex'), { recursive: true, mode: 0o700 });
    await mkdir(join(home, '.daimon-inbound'), { recursive: true, mode: 0o700 });
    for (const file of [join(home, '.codex/auth.json'), join(home, '.daimon-inbound/.paideia-canary')]) {
      try { const handle = await open(file, 'wx', 0o600); await handle.writeFile('{}'); await handle.close(); owned.push(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      denied.push(file);
    }
    const input = join(scratch, 'input'), complete = join(scratch, 'complete'); await writeFile(input, 'NATIVE_READ');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const code = nativeChildProbe(input, complete, denied, port);
    await promisify(execFile)(receipt.projection.executablePath, [...receipt.projection.sandboxArgs, '--', process.execPath, '-e', code], {
      cwd: launch.workspace.target, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), TMPDIR: '/tmp', LANG: 'C.UTF-8' }, signal, timeout: 15000, maxBuffer: 65536,
    });
    if (await readFile(complete, 'utf8') !== 'NATIVE_POLICY_COMPLETE') throw new Error('Native sandbox did not finish enforcement checks');
    await writeFile(join(artifacts, 'child-sandbox-preflight.json'), JSON.stringify({ schema: 'paideia.daimon-native.child-sandbox-preflight.v1',
      trialId, configSha256: launch.configSha256, projectionSha256: receipt.projectionSha256, modelCallsMade: 0, workspaceReadWrite: true, protectedPathsDenied: true, networkDenied: true }), { flag: 'wx', mode: 0o600 });
  } catch (error) { throw new Error('Exact native child sandbox failed before cognition', { cause: error }); }
  finally { server.close(); await Promise.all([...owned, scratch].map(path => rm(path, { recursive: true, force: true }))); }
}
