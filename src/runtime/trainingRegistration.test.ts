import { expect, it, vi } from 'vitest';
import { loadRuntimeRegistry, hasRuntimeAdapter } from './registry.js';
import { createTrainingSubjects, main, trainingDependencies } from './trainingSubjects.js';

const loading = vi.hoisted(() => ({ count: 0 }));
vi.mock('./daimon/training/index.js', async importOriginal => {
  loading.count++;
  return importOriginal<typeof import('./daimon/training/index.js')>();
});

it('leaves training adapters unloaded for compilation and resolves them only at training composition', async () => {
  const entries = await loadRuntimeRegistry();
  expect(loading.count).toBe(0);
  expect(entries.find(entry => entry.name === 'daimon')!.training!.subject).toBeTypeOf('function');
  expect(hasRuntimeAdapter('codex-exec')).toBe(false);
  const subjects = await createTrainingSubjects(entries);
  expect(loading.count).toBe(1);
  expect(Object.keys(subjects).sort()).toEqual(['codex', 'daimon']);
  expect(subjects.daimon!.hostInference!.grantAuthority).toBeTypeOf('function');
});

it('preserves explicit dependency injection and composes the imported CLI entry', async () => {
  const subjects = await createTrainingSubjects([]);
  expect(Object.keys(subjects)).toEqual(['codex']);
  expect((await trainingDependencies({ subjects })).subjects).toBe(subjects);
  const stdout: string[] = [];
  expect(await main(['--help'], { cwd: process.cwd(), stdout: text => { stdout.push(text); }, stderr: vi.fn() }, { subjects })).toBe(0);
  expect(stdout.join('')).toContain('train');
});
