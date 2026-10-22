import type { NativeLaunch } from '../receipt/index.js';

/** The compiled Daimon agent fields this check reads (structurally Daimon's runtime config agent). */
export interface NativeAgentConfig {
  id: string;
  engine: { kind: string; model?: string; reasoningEffort?: string; codexSandbox?: Readonly<Record<string, unknown>> };
}

/**
 * Refuse a compiled agent config whose engine differs from the launch agent,
 * before any subject starts.
 *
 * Codex: the same agent and model, with exactly the `workspace-no-network`
 * sandbox (`workspace-write`, no network access, web search disabled, and no
 * other sandbox field). Grok: the same agent, model and reasoning effort, and no
 * Codex sandbox at all — the broker realm is its containment.
 */
export function assertNativeEngineConfig(agentConfig: NativeAgentConfig, launchAgent: NativeLaunch['agent']): void {
  const engine = agentConfig.engine;
  if (agentConfig.id !== launchAgent.id) throw new Error('Compiled native agent differs from the launch agent');
  if (engine.kind !== launchAgent.engine || engine.model !== launchAgent.model) {
    throw new Error('Compiled native engine or model differs from the launch agent');
  }
  if (launchAgent.engine === 'grok') {
    if (engine.reasoningEffort !== launchAgent.reasoningEffort) throw new Error('Compiled Grok reasoning effort differs from the launch agent');
    if (engine.codexSandbox !== undefined) throw new Error('A Grok subject cannot declare a Codex sandbox');
    return;
  }
  const sandbox = engine.codexSandbox;
  if (!engine.model?.trim() || !sandbox || sandbox.mode !== 'workspace-write' || sandbox.networkAccess !== false ||
      sandbox.webSearch !== 'disabled' || Object.keys(sandbox).length !== 3) {
    throw new Error('A Codex subject requires the explicit workspace-no-network sandbox (codex_policy: workspace-no-network)');
  }
}
