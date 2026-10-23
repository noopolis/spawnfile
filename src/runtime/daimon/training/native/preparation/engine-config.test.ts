import { describe, expect, it } from 'vitest';
import { assertNativeEngineConfig, type NativeAgentConfig } from './engine-config.js';

const sandbox = { mode: 'workspace-write', networkAccess: false, webSearch: 'disabled' };
const codex = (): NativeAgentConfig => ({ id: 'agent:writer', engine: { kind: 'codex', model: 'gpt-5.5', codexSandbox: { ...sandbox } } });
const grok = (): NativeAgentConfig => ({ id: 'agent:writer', engine: { kind: 'grok', model: 'grok-4.6', reasoningEffort: 'low' } });
const codexAgent = { id: 'agent:writer', engine: 'codex' as const, model: 'gpt-5.5' };
const grokAgent = { id: 'agent:writer', engine: 'grok' as const, model: 'grok-4.6' as const, reasoningEffort: 'low' as const };

describe('assertNativeEngineConfig', () => {
  it('admits the exact workspace-no-network Codex sandbox and the matching Grok model and effort', () => {
    expect(() => assertNativeEngineConfig(codex(), codexAgent)).not.toThrow();
    expect(() => assertNativeEngineConfig(grok(), grokAgent)).not.toThrow();
  });

  it('refuses every other Codex sandbox shape', () => {
    for (const codexSandbox of [undefined, { ...sandbox, mode: 'danger-full-access' }, { ...sandbox, networkAccess: true },
      { ...sandbox, webSearch: 'live' }, { ...sandbox, writableRoots: ['/'] }, { mode: 'workspace-write', networkAccess: false }]) {
      const config = codex();
      config.engine.codexSandbox = codexSandbox;
      expect(() => assertNativeEngineConfig(config, codexAgent)).toThrow('workspace-no-network');
    }
    const blank = codex();
    blank.engine.model = ' ';
    expect(() => assertNativeEngineConfig(blank, { ...codexAgent, model: ' ' })).toThrow('workspace-no-network');
  });

  it('refuses a different agent, engine or model for either engine', () => {
    expect(() => assertNativeEngineConfig({ ...codex(), id: 'agent:other' }, codexAgent)).toThrow('launch agent');
    expect(() => assertNativeEngineConfig(codex(), { ...codexAgent, model: 'gpt-5.4' })).toThrow('engine or model');
    expect(() => assertNativeEngineConfig(grok(), codexAgent)).toThrow('engine or model');
    expect(() => assertNativeEngineConfig(codex(), grokAgent)).toThrow('engine or model');
    expect(() => assertNativeEngineConfig(grok(), { ...grokAgent, model: 'grok-4.5' })).toThrow('engine or model');
  });

  it('refuses a Grok effort mismatch or any Codex sandbox on Grok', () => {
    expect(() => assertNativeEngineConfig(grok(), { ...grokAgent, reasoningEffort: 'high' })).toThrow('reasoning effort');
    const config = grok();
    delete config.engine.reasoningEffort;
    expect(() => assertNativeEngineConfig(config, grokAgent)).toThrow('reasoning effort');
    const sandboxed = grok();
    sandboxed.engine.codexSandbox = { ...sandbox };
    expect(() => assertNativeEngineConfig(sandboxed, grokAgent)).toThrow('Codex sandbox');
  });
});
