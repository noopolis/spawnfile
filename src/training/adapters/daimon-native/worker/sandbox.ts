import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindNativeSandboxProjection, parseNativeSandboxReceipt } from '../receipt/index.js';
import type { NativeRuntimeModule } from './public.js';
import type { NativeConfig, WorkerOptions } from './types.js';

export async function persistNativeSandboxProjection(runtime: NativeRuntimeModule, config: NativeConfig, options: WorkerOptions): Promise<void> {
  const agent = config.agents[0]!;
  const value = await runtime.resolveOrganizationCodexSandboxProjection(config, agent.id, { acceptanceStorePath: options.controlRoot });
  const receipt = bindNativeSandboxProjection(value, options.trialId, options.configSha256);
  parseNativeSandboxReceipt(receipt, { trialId: options.trialId, configSha256: options.configSha256,
    agentId: agent.id, workspacePath: agent.workspacePath, runtimeHomePath: agent.runtimeHomePath });
  await writeFile(join(options.controlRoot, 'sandbox-projection.json'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
}
