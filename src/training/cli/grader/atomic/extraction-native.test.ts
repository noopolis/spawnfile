import { expect, it } from 'vitest';
import type { ProcessOptions, RunningProcess } from '../../../platform/process/index.js';
import { createCodexInference } from '../../../inference/codex/index.js';
import { createClaudeInference } from '../../../inference/claude/index.js';
import { runDecompose } from './decompose.js';
import { fixture } from './fixtures.js';

it.each(['codex', 'claude'] as const)('completes extraction through actual %s schema validation with fenced final answers', async vendor => {
  const f = await fixture();
  let generations = 0;
  const process = (options: ProcessOptions): RunningProcess => ({
    write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => {
      if (options.args.includes('status')) {
        await options.onLine(vendor === 'codex' ? 'Logged in using ChatGPT' :
          JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), new AbortController().signal);
      } else {
        if (vendor === 'claude') {
          const schema = JSON.parse(options.args[options.args.indexOf('--json-schema') + 1]!);
          expect(schema).toMatchObject({ $schema: 'http://json-schema.org/draft-07/schema#', additionalProperties: false });
        }
        const text = '```json\n' + JSON.stringify({ units: generations++ === 0 ? [f.unit] : [] }) + '\n```';
        const frames = vendor === 'codex' ? [
          { type: 'thread.started', thread_id: 't', model: 'actual' }, { type: 'turn.started' },
          { type: 'item.completed', item: { id: 'a', type: 'agent_message', text } },
          { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
        ] : [
          { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'actual' },
          { type: 'result', subtype: 'success', result: text },
        ];
        for (const frame of frames) await options.onLine(JSON.stringify(frame), new AbortController().signal);
      }
      return { exitCode: 0, stderr: '', cancelled: false };
    })(),
  });
  const provider = vendor === 'codex' ? createCodexInference({ process }) : createClaudeInference({ process });
  expect(await runDecompose({ ...f.decompose, extractors: [vendor] }, { provider: () => provider }))
    .toMatchObject({ completed: 1, rejected: 0 });
  expect(generations).toBe(2);
});
