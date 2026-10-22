/** Structural subset of the optional runtime's public contracts; no SDK import in core. */
export interface NativeTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(callId: string, args: unknown, signal?: AbortSignal): Promise<{
    content: { type: 'text'; text: string }[];
    details: unknown;
  }>;
}

export interface NativeHandle {
  wake(event: { id: string; kind: 'manual'; text: string }): Promise<{ text: string }>;
  stop(): Promise<void>;
  status(): { state: string };
}

export interface NativeHarness {
  startAgent(input: {
    id: string; name: string; instructions: string; workspacePath: string; runtimeHomePath: string; tools: string[]; causalRunId: string;
  }): Promise<NativeHandle>;
}

export interface DaimonModule {
  PiHarnessAdapter: {
    new (options: Record<string, unknown>): NativeHarness;
    capabilities?: { causalRunId?: boolean };
  };
  createCliSessionFactory(options: Record<string, unknown>): unknown;
  renderCodexArgs(options: Record<string, unknown>, cwd: string, endpoint?: string): string[];
}

export async function loadDaimon(): Promise<DaimonModule> {
  const packageName = '@noopolis/daimon/pi';
  let loaded: Record<string, unknown>;
  try { loaded = await import(packageName) as Record<string, unknown>; }
  catch (error) { throw new Error('Install optional @noopolis/daimon with its public /pi export to use this adapter', { cause: error }); }
  if (typeof loaded['PiHarnessAdapter'] !== 'function' || typeof loaded['createCliSessionFactory'] !== 'function' ||
    typeof loaded['renderCodexArgs'] !== 'function') {
    throw new Error('Installed Daimon is missing required public Pi/CLI interfaces');
  }
  return loaded as unknown as DaimonModule;
}
