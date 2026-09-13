import type { Observation, Usage } from '../../contracts/execution.js';

export interface CodexProtocol {
  text: string;
  threadId?: string;
  completed: boolean;
  failed?: string;
  usage: Usage | null;
  cumulativeUsage: Usage | null;
  decode(line: string): Promise<void>;
}

export function decodeCodex(
  trialId: string, wakeId: string, emit: (observation: Observation) => void | Promise<void>,
  previousUsage?: Usage | null,
): CodexProtocol {
  let seq = 0;
  const source = `codex:${trialId}:${wakeId}`;
  const dispatch = new Map<string, string>();
  const output = async (value: Omit<Observation, 'id' | 'source' | 'seq' | 'trialId' | 'wakeId' | 'timestamp'>): Promise<string> => {
    const id = `${source}:${++seq}`;
    await emit({ id, source, seq, trialId, wakeId, timestamp: new Date().toISOString(), ...value });
    return id;
  };
  const state: CodexProtocol = {
    text: '', completed: false, usage: null, cumulativeUsage: null,
    async decode(line) {
      const event = asObject(JSON.parse(line));
      if (typeof event['type'] !== 'string') throw new Error('Invalid Codex event envelope');
      if (event['type'] === 'thread.started') {
        if (typeof event['thread_id'] !== 'string') throw new Error('Missing Codex thread identity');
        state.threadId = event['thread_id'];
      }
      if (event['type'] === 'turn.completed') {
        state.completed = true;
        state.cumulativeUsage = codexUsage(event['usage']);
        state.usage = previousUsage === undefined ? state.cumulativeUsage : usageDelta(state.cumulativeUsage, previousUsage);
        await output({ type: 'usage', usage: state.usage, native: event });
      }
      if (event['type'] === 'turn.failed' || event['type'] === 'error') {
        state.failed = typeof event['message'] === 'string' ? event['message'] : JSON.stringify(event['error'] ?? event);
        await output({ type: 'diagnostic', text: state.failed, native: event });
      }
      if (!String(event['type']).startsWith('item.')) return;
      const item = asObject(event['item']);
      if (item['type'] === 'agent_message' && event['type'] === 'item.completed') {
        if (typeof item['text'] !== 'string') throw new Error('Invalid Codex assistant output');
        state.text = item['text'];
        await output({ type: 'output', text: state.text, native: event });
      }
      const tool = nativeTool(item);
      if (tool === undefined) return;
      if (typeof item['id'] !== 'string') throw new Error('Missing native call identity');
      const callId = item['id'];
      if (event['type'] === 'item.started') {
        const id = await output({ type: 'tool.dispatch', callId, tool: tool.name, args: tool.args, native: event });
        dispatch.set(callId, id);
      }
      if (event['type'] === 'item.completed') {
        const parent = dispatch.get(callId);
        await output({ type: 'tool.complete', callId, tool: tool.name, args: tool.args,
          result: item['result'] ?? item['aggregated_output'] ?? item['changes'],
          success: success(item), causalParents: parent === undefined ? [] : [parent], native: event });
      }
    },
  };
  return state;
}

/** Native resumed exec reports cumulative thread counters; compare matching session baselines. */
export function usageDelta(current: Usage, previous: Usage | null): Usage {
  const subtract = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens'): number | null => {
    const value = current[key];
    const baseline = previous?.[key];
    return value !== null && baseline !== undefined && baseline !== null && value >= baseline ? value - baseline : null;
  };
  return { inputTokens: subtract('inputTokens'), cachedInputTokens: subtract('cachedInputTokens'),
    outputTokens: subtract('outputTokens'), reasoningTokens: subtract('reasoningTokens'), source: 'codex.thread.usage.delta' };
}

function nativeTool(item: Record<string, unknown>): { name: string; args: unknown } | undefined {
  if (item['type'] === 'command_execution') return { name: 'shell', args: { command: item['command'] } };
  if (item['type'] === 'mcp_tool_call') return { name: String(item['tool']), args: item['arguments'] };
  if (item['type'] === 'file_change') return { name: 'apply_patch', args: item['changes'] };
  if (item['type'] === 'web_search') return { name: 'web_search', args: { query: item['query'] } };
  return undefined;
}

function success(item: Record<string, unknown>): boolean | undefined {
  if (item['status'] === 'failed' || item['error'] !== undefined) return false;
  if (typeof item['exit_code'] === 'number') return item['exit_code'] === 0;
  return item['status'] === 'completed' ? true : undefined;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected protocol object');
  return value as Record<string, unknown>;
}

export function codexUsage(value: unknown): Usage {
  const usage = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const count = (key: string): number | null => {
    const entry = usage[key];
    return typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : null;
  };
  return { inputTokens: count('input_tokens'), cachedInputTokens: count('cached_input_tokens'),
    outputTokens: count('output_tokens'), reasoningTokens: count('reasoning_output_tokens'), source: 'codex.turn.completed' };
}
