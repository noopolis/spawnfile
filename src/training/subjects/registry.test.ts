import { expect, test, vi } from 'vitest';
import type { InferenceGrantAuthority as GrokInferenceGrantAuthority, SubjectAdapter } from '../contracts/index.js';
import { resolveSubjectAdapter, subjectHostInference, type SubjectAdapterRegistry } from './registry.js';
const fixtureAdapter = (): SubjectAdapter => ({ id: 'fixture' } as SubjectAdapter);

test('selects only an explicitly registered factory and forwards its options', () => {
  const adapter = fixtureAdapter();
  const create = vi.fn(() => adapter);
  const registry = { fixture: { create } };
  const options = { model: 'explicit', timeoutMs: 42 };
  expect(resolveSubjectAdapter(registry, 'fixture', options)).toBe(adapter);
  expect(create).toHaveBeenCalledExactlyOnceWith(options);
  for (const id of ['missing', 'toString', '__proto__']) expect(() => resolveSubjectAdapter(registry, id, options)).toThrow('unknown subject');
  expect(() => resolveSubjectAdapter(undefined, 'fixture', options)).toThrow('none registered');
});

test('requires one unambiguous optional host inference capability', async () => {
  const authority = {} as GrokInferenceGrantAuthority;
  const grantAuthority = vi.fn(async () => authority);
  const subject = { create: () => fixtureAdapter(), hostInference: { grantAuthority } };
  const selected = subjectHostInference({ one: subject, plain: { create: subject.create } });
  expect(await selected.grantAuthority('/broker.sock')).toBe(authority);
  expect(grantAuthority).toHaveBeenCalledExactlyOnceWith('/broker.sock');
  const invalid: (SubjectAdapterRegistry | undefined)[] = [undefined, {}, { plain: { create: subject.create } }, { one: subject, two: subject }];
  for (const registry of invalid) {
    expect(() => subjectHostInference(registry)).toThrow('Exactly one');
  }
});
