import type { NativeLaunch } from '../receipt/index.js';

/** Only fields consumed from Daimon's public /runtime contract are described here. */
export interface NativeConfig {
  version: string;
  host: { bindHost: string; port: number; controlTokenEnv: string };
  agents: { id: string; name: string; instructions: string; workspacePath: string; runtimeHomePath: string;
    engine: { kind: string; model?: string; codexSandbox?: { mode: string; networkAccess: boolean; webSearch: string }; reasoningEffort?: string };
    attention?: { maxBatchMessages: number; maxBatchBytes: number; maxExecutions: number; maxTokens: number };
    schedule?: { kind: string; [key: string]: unknown };
    memory?: { runtimeHomePath: string; [key: string]: unknown };
    moltnet?: { cliPath: string; configPath: string; networks: { id: string; rooms: string[]; dms: boolean }[] };
    mcp?: { name: string; transport: string; command?: string; args: string[]; env: Record<string, string>; tools: string[] }[];
  }[];
}
export interface NativeReceipt {
  version: string; acceptance_id: string; agent_id: string; delivery_id: string; request_digest: string;
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'stopped'; accepted_at: string; updated_at: string;
  execution_id?: string; deferred?: boolean; code?: string; text?: string;
}
export interface NativeActivity {
  version: string; items: (NativeReceipt & { active: boolean })[];
  executions?: { agent_id: string; execution_id: string; state: 'running'; delivery_ids: string[] }[];
}
export interface NativeAvailability {
  version: string; state: string;
  agents: { agent_id: string; pending: number; running: boolean; deferred: number; budget: unknown; error?: string }[];
}
export interface NativeHost {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  health(): Promise<{ version: string; state: string; agents: { agentId: string; engine?: string; state?: string }[] }>;
  accept(request: unknown): Promise<{ state: 'accepted'; acceptance_id: string } | { state: 'rejected' | 'stopped'; code: string }>;
  wakeReceipt(token: string | undefined, acceptanceId: string): Promise<NativeReceipt | undefined>;
  activityV2(token: string | undefined): Promise<NativeActivity | undefined>;
  availability(token: string | undefined): Promise<NativeAvailability | undefined>;
}
export interface WorkerOptions {
  config: string;
  configSha256: string;
  controlRoot: string;
  tokenFile: string;
  evidence: string;
  trialId: string;
  timeoutMs: number;
  scheduleOverride: 'disabled';
  launch: string;
}
export interface NativeTrace extends Record<string, unknown> {
  schema: 'daimon.turn_trace.v1';
  agent_id: string;
  turn_id: string;
  started_at: string;
  completed_at: string;
  status: 'completed' | 'failed';
  tools: unknown[];
}
export interface NativeUsage extends Record<string, unknown> {
  v: 'noopolis.daimon.turn-usage.v1';
  agent: string;
  wake: string;
  engine: 'codex';
  input: number;
  output: number;
  cache_read: number;
  total: number;
  complete: boolean;
}
export interface NativeEvidence {
  traces: NativeTrace[];
  usage: NativeUsage[];
  toolReceipts: Record<string, unknown>[];
  modelContexts: { model: string; approvalPolicy: unknown; sandboxPolicy: unknown }[];
}
export interface TerminalEvidence {
  schema: 'paideia.daimon-native.trial.v1';
  trialId: string;
  wakeId: string;
  agentId: string;
  model: string;
  configSha256: string;
  scheduleOverride: 'disabled';
  preparation?: Pick<NativeLaunch, 'sourceConfigSha256' | 'instructions' | 'overrides'>;
  status: 'completed' | 'failed' | 'cancelled';
  /** A closed execution can leave its delivery deferred; this never marks the trial completed. */
  blocked?: 'awaiting-external-input';
  startedAt: string;
  completedAt: string;
  executionId?: string;
  receipt?: NativeReceipt;
  activity?: NativeActivity;
  availability?: NativeAvailability;
  native: NativeEvidence;
  coverage: { channel: 'tools' | 'output' | 'usage'; completeness: 'absent' | 'partial' | 'complete'; ordering: 'source' | 'none' }[];
  error?: string;
}
