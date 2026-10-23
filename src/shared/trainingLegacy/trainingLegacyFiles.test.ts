import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkTrainingFilename, readTrainingBytes } from './trainingLegacyFiles.js';
const readCliText = (path: string, maximum: number): string => new TextDecoder('utf-8', { fatal: true }).decode(readTrainingBytes(path, maximum));

const roots: string[] = [];
function directory(): string { const root = mkdtempSync(join(tmpdir(), 'training-legacy-files-')); roots.push(root); return root; }
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('reads explicit legacy YAML/JSON filenames unchanged and warns on stderr', () => {
  const root = directory(), stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  for (const name of ['.paideia.yaml', 'train.paideia.yaml', 'test.paideia.yml', 'train.paideia.json']) {
    const file = join(root, name);
    writeFileSync(file, 'original bytes');
    expect(readCliText(file, 100)).toBe('original bytes');
  }
  expect(stderr).toHaveBeenCalledTimes(4);
  expect(stderr.mock.calls[0]![0]).toMatch(/Deprecated.*spawnfile-training/u);
});

it('rejects ambiguous legacy/current sibling files whichever spelling was selected', () => {
  const root = directory();
  for (const prefix of ['', 'train']) {
    const legacy = join(root, `${prefix}.paideia.yaml`), current = join(root, `${prefix}.spawnfile-training.yaml`);
    writeFileSync(legacy, 'old'); writeFileSync(current, 'new');
    expect(() => readCliText(legacy, 100)).toThrow(/Both legacy and current training files exist/u);
    expect(() => readCliText(current, 100)).toThrow(/Both legacy and current training files exist/u);
  }
});

it('reads current and unrelated names without warnings; missing files keep their filesystem error', () => {
  const root = directory(), stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  for (const name of ['.spawnfile-training.yaml', 'train.spawnfile-training.yaml', 'plain.yaml']) {
    const file = join(root, name); writeFileSync(file, 'current');
    expect(readCliText(file, 100)).toBe('current');
  }
  const missing = join(root, 'missing.paideia.yaml');
  expect(() => checkTrainingFilename(missing)).not.toThrow();
  expect(() => readCliText(missing, 100)).toThrow(/ENOENT/u);
  expect(stderr).not.toHaveBeenCalled();
});
