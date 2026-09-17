import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindGrokBrokerProjection, bindNativeSandboxProjection, grokBrokerProjectionSchema, grokProjectionSha256, isGrokLaunch, parseGrokBrokerReceipt,
  parseNativeSandboxReceipt, readPrivateFile, type GrokNativeLaunch, type NativeLaunch } from '../receipt/index.js';
import type { NativeRuntimeModule } from './public.js';
import type { NativeConfig, WorkerOptions } from './types.js';

export async function persistNativeSandboxProjection(runtime: NativeRuntimeModule, config: NativeConfig, options: WorkerOptions, launch?: NativeLaunch): Promise<void> {
  if (launch && isGrokLaunch(launch)) return persistGrokBrokerProjection(runtime, config, options, launch);
  const agent = config.agents[0]!;
  const value = await runtime.resolveOrganizationCodexSandboxProjection(config, agent.id, { acceptanceStorePath: options.controlRoot });
  const receipt = bindNativeSandboxProjection(value, options.trialId, options.configSha256);
  parseNativeSandboxReceipt(receipt, { trialId: options.trialId, configSha256: options.configSha256,
    agentId: agent.id, workspacePath: agent.workspacePath, runtimeHomePath: agent.runtimeHomePath });
  await writeFile(join(options.controlRoot, 'sandbox-projection.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
}

/**
 * Grok never runs a `codex sandbox` probe. Daimon resolves the slot projection
 * from the launch's broker inputs; its digest must equal the launch receipt and
 * Daimon's own digest, and the root supervisor's slot preflight receipt must
 * verify against it (Daimon's verifier) and deny every evaluator root.
 */
async function persistGrokBrokerProjection(runtime: NativeRuntimeModule, config: NativeConfig, options: WorkerOptions, launch: GrokNativeLaunch): Promise<void> {
  const { resolveOrganizationGrokBrokerProjection: resolve, grokBrokerProjectionSha256: digest, verifyGrokSlotPreflightReceipt: verify } = runtime;
  if (!resolve || !digest || !verify) throw new Error('Installed Daimon lacks the Grok broker projection and slot preflight capability');
  const agent = config.agents[0]!;
  const { broker } = launch;
  const projection = grokBrokerProjectionSchema.parse(resolve(config, agent.id, { slot: broker.slot, workerUid: broker.workerUid,
    workerHomePath: broker.workerHomePath, architecture: broker.architecture, usageLedgerPath: broker.usageLedgerPath, limits: broker.limits,
    acceptanceStorePath: options.controlRoot, denyPaths: [...new Set(broker.evaluatorPaths.map(row => row.path))].sort(),
    seccompProfileSha256: broker.seccompProfileSha256 }));
  const sha = grokProjectionSha256(projection);
  if (digest(projection) !== sha) throw new Error('Paideia and Daimon disagree on the Grok broker projection digest');
  if (projection.version !== broker.projectionVersion || sha !== broker.projectionSha256) throw new Error('Grok broker projection digest differs from the launch receipt');
  if (projection.limits.timeoutMs > options.timeoutMs) throw new Error('Grok broker turn timeout exceeds the trial deadline');
  let slot: unknown;
  try { slot = JSON.parse(await readPrivateFile(broker.slotPreflightReceipt, 262144)); }
  catch (error) { throw new Error('Grok subject turns require the root slot supervisor preflight receipt', { cause: error }); }
  const verified = verify(slot, projection);
  const receipt = parseGrokBrokerReceipt(bindGrokBrokerProjection(projection, verified, options.trialId, options.configSha256), launch, options.trialId);
  await writeFile(join(options.controlRoot, 'sandbox-projection.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
}
