import type { NativeConfig, NativeHost } from './types.js';
import type { NativeSandboxProjection } from '../receipt/index.js';

/** Structural public seam keeps the optional runtime out of Paideia core installs. */
export interface NativeRuntimeModule {
  parseOrganizationRuntimeConfig(value: unknown): NativeConfig;
  createOrganizationRuntimeControlHost(value: unknown, options: { acceptanceStorePath: string; controlToken: string }): NativeHost;
  resolveOrganizationCodexSandboxProjection(value: unknown, agentId: string, options: { acceptanceStorePath: string }): Promise<NativeSandboxProjection>;
}

export async function loadDaimonRuntime(): Promise<NativeRuntimeModule> {
  const packageName = '@noopolis/daimon/runtime';
  let loaded: Record<string, unknown>;
  try { loaded = await import(packageName) as Record<string, unknown>; }
  catch (error) { throw new Error('Install optional @noopolis/daimon with its public /runtime export', { cause: error }); }
  if (typeof loaded['parseOrganizationRuntimeConfig'] !== 'function' || typeof loaded['createOrganizationRuntimeControlHost'] !== 'function') {
    throw new Error('Installed Daimon lacks the native organization control host');
  }
  if (typeof loaded['resolveOrganizationCodexSandboxProjection'] !== 'function') throw new Error('Installed Daimon lacks exact native sandbox projection capability');
  return loaded as unknown as NativeRuntimeModule;
}
