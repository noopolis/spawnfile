import { randomUUID } from 'node:crypto';
import { open, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TrainingReport } from '../../experiments/index.js';
import { unifiedDiff } from './diff.js';
import { renderTrainingMarkdown } from './markdown.js';
import { summarizeTraining } from './summary.js';

/** Export only a completed training envelope; legacy/failed reports keep their protected blobs. */
export function isTrainingReport(value: unknown): value is TrainingReport {
  return typeof value === 'object' && value !== null && 'schema' in value && value.schema === 'paideia.training.v1';
}

async function writeVerified(path: string, bytes: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  if (await readFile(path, 'utf8') !== bytes) throw new Error('Training export did not persist faithfully');
}

async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTree(join(path, entry.name));
  }
  await syncDirectory(path);
}

/** Immutable snapshot first, then atomic replacement of each operator-facing companion. */
export async function exportTrainingReport(root: string, report: TrainingReport) {
  const summary = summarizeTraining(report);
  const directory = `training-report-${randomUUID()}`;
  const staged = await mkdtemp(join(root, '.training-report-'));
  try {
    const diffs: Record<string, string> = {};
    for (const entry of summary.candidates) {
      const target = join(staged, 'candidates', entry.label);
      await writeVerified(join(target, 'manifest.json'), `${JSON.stringify(entry.candidate, null, 2)}\n`);
      for (const resource of entry.candidate.resources) {
        await writeVerified(join(target, 'files', resource.sourcePath), resource.content);
      }
      diffs[entry.label] = entry.candidate.resources.map(resource => unifiedDiff(resource.sourcePath,
        report.baseline.resources.find(original => original.id === resource.id)!.content, resource.content)).join('');
      await writeVerified(join(target, 'baseline.diff'), diffs[entry.label]!);
    }
    const json = `${JSON.stringify({ ...summary, bundle: directory }, null, 2)}\n`;
    const markdown = renderTrainingMarkdown(summary, '.', diffs);
    await writeVerified(join(staged, 'REPORT.json'), json);
    await writeVerified(join(staged, 'REPORT.md'), markdown);
    // Sync directory entries as well as file contents before exposing the snapshot.
    await syncTree(staged);
    await rename(staged, join(root, directory));
    for (const [name, bytes] of [['REPORT.json', json], ['REPORT.md', renderTrainingMarkdown(summary, directory, diffs)]]) {
      const temporary = join(root, `.${name}-${randomUUID()}`);
      try { await writeVerified(temporary, bytes!); await rename(temporary, join(root, name!)); }
      finally { await rm(temporary, { force: true }); }
    }
    await syncDirectory(root);
    return { directory, markdown: `${directory}/REPORT.md`, json: `${directory}/REPORT.json` };
  } finally { await rm(staged, { recursive: true, force: true }); }
}
