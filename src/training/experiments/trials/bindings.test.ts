import { expect, it } from 'vitest';
import { captureBindings, resolveTurnInput } from './bindings.js';
import type { TurnBinding } from '../../contracts/dataset.js';
import { observation } from '../../testing/index.js';

it('binds authentic native values once and injects typed values into a later stimulus', () => {
  const binding: TurnBinding = { event: 'tool.complete', distinct: 'call.id', cardinality: 'one', value: 'call.result',
    where: { cel: "call.tool == 'request'" } };
  const events = [observation({ tool: 'request' }), observation({ id: 'complete', seq: 2, tool: 'request', type: 'tool.complete', result: { id: 'r1' }, success: true })];
  const values = captureBindings({ request: binding }, { events, context: {} });
  expect(values).toEqual({ request: { id: 'r1' } });
  expect(resolveTurnInput({ prompt: 'reply', message: { reply: { binding: 'request.id' }, nested: [1, { value: true }] } }, values))
    .toEqual({ prompt: 'reply', message: { reply: 'r1', nested: [1, { value: true }] } });
  expect(() => resolveTurnInput({ data: { binding: 'missing' } }, values)).toThrow('Unavailable');
  expect(() => captureBindings({ request: binding }, { events: [], context: {} })).toThrow('exactly one');
  expect(() => captureBindings({ request: { ...binding, where: { cel: 'false' } } }, { events, context: {} })).toThrow('exactly one');
  expect(() => captureBindings({ request: { ...binding, value: 'call.absent' } }, { events, context: {} })).toThrow('Missing');
  const output = observation({ id: 'output', type: 'output', text: 'answer', callId: undefined, tool: undefined });
  expect(captureBindings({ answer: { ...binding, event: 'output', distinct: 'event.id', value: 'event.text', where: undefined } }, { events: [output], context: {} })).toEqual({ answer: 'answer' });
  expect(() => captureBindings({ answer: { ...binding, event: 'output', value: 'event.text', where: undefined } }, { events: [output], context: {} })).toThrow('Missing');
  expect(() => captureBindings({ answer: { ...binding, event: 'output', distinct: 'event.id', value: 'event.text', where: undefined } },
    { events: [output, { ...output, text: 'conflict' }], context: {} })).toThrow('Ambiguous');
});
