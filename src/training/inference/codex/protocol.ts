import type { Usage, InferenceFailureKind } from '../../contracts/execution.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceResponse } from '../response-schema.js';

export interface CodexFrames {
  started: boolean;
  turning: boolean;
  completed: boolean;
  text: string;
  model?: string;
  usage: Usage | null;
}
export function codexEvidence(frames: CodexFrames) {
  return { responseModel: frames.model ?? null, responseRoute: 'codex-subscription', usage: frames.usage };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

/** Unknown item types are tool activity, including future native tool families. */
export function consumeCodexFrame(frames: CodexFrames, line: string): void {
  try {
    validateInferenceResponse(line, { type: 'object' });
    const event = object(JSON.parse(line));
    const type = event['type'];
    if (typeof type !== 'string') throw new Error('Missing event type');
    if (type.startsWith('item.')) {
      const item = object(event['item']);
      if (item['type'] !== 'agent_message' && item['type'] !== 'reasoning') {
        throw new InferenceFailure('protocol', 'Codex attempt refused: tool-call', { ...codexEvidence(frames), detail: 'tool-call' });
      }
      const text = item['text'];
      if (!frames.turning || frames.completed || !['item.started', 'item.updated', 'item.completed'].includes(type) ||
        typeof item['id'] !== 'string' ||
        !(typeof text === 'string' || type === 'item.started' && text === undefined)) throw new Error('Invalid item');
      if (type === 'item.completed' && item['type'] === 'agent_message' && typeof text === 'string') frames.text = text;
    } else if (type === 'error' || type === 'turn.failed') {
      const error = type === 'error' ? event : object(event['error']);
      throw new InferenceFailure(classifyCodexFailure(error['message']), 'Codex native generation failed', codexEvidence(frames));
    } else if (type === 'thread.started') {
      if (frames.started || typeof event['thread_id'] !== 'string') throw new Error('Invalid thread');
      frames.started = true;
    } else if (type === 'turn.started') {
      if (!frames.started || frames.turning) throw new Error('Invalid turn');
      frames.turning = true;
    } else if (type === 'turn.completed') {
      if (!frames.turning || frames.completed || !frames.text.trim()) throw new Error('Incomplete turn');
      frames.completed = true;
      if (event['usage'] !== undefined) frames.usage = codexUsage(object(event['usage']));
    } else throw new Error('Unknown event');
    if (typeof event['model'] === 'string' && event['model'].trim()) frames.model = event['model'];
  } catch (error) {
    if (error instanceof InferenceFailure) throw error;
    throw new InferenceFailure('protocol', 'Malformed Codex event stream', codexEvidence(frames));
  }
}

export function classifyCodexFailure(message: unknown): InferenceFailureKind {
  if (typeof message !== 'string') return 'protocol';
  if (/unauthorized|authentication|sign in|login|401|403/iu.test(message)) return 'authentication';
  if (/quota|usage limit|rate limit|429|402|payment/iu.test(message)) return 'quota';
  if (/connection|transport|network|stream disconnected|reconnecting/iu.test(message)) return 'transport';
  return 'protocol';
}

function codexUsage(raw: Record<string, unknown>): Usage {
  const count = (key: string): number | null => typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : null;
  return { inputTokens: count('input_tokens'), cachedInputTokens: count('cached_input_tokens'),
    outputTokens: count('output_tokens'), reasoningTokens: count('reasoning_output_tokens'), source: 'codex.turn.usage' };
}
