import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openExperimentStore } from '../../storage/index.js';
import { main, type InvocationIndex } from '../index.js';
import { cliFixture, datasetText } from '../fixture.js';
import { loadInvocationViewer } from '../viewer.js';
import type { CliFailureReport } from './failure.js';
import * as viewer from '../../../viewer/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(blockIndex = false) {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'train.yaml'), datasetText([{ id: 'first', group: 'a' }, { id: 'selection', group: 'b' }]));
  await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'SEALED-case', group: 'sealed' }]));
  const generate = vi.fn(async () => {
    if (blockIndex) await mkdir(join(f.root, 'out/invocation.json'));
    throw new Error('PRIVATE provider failure');
  });
  f.dependencies.inference = () => ({ id: 'test-subscription',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false }, generate });
  const args = ['train', '--train', 'train.yaml', '--test', 'test.yaml', ...f.nativeArgs,
    '--editable', 'AGENTS.md', '--optimizer-model', 'fixture-model', '--bridge-command', f.bridge,
    '--validation-group', 'b', '--max-trials', '6', '--max-proposals', '1', '--timeout-ms', '15000', '--view', '0'];
  return { ...f, args, generate };
}

describe('failed CLI invocation remains inspectable without repeating work', () => {
  it('stores partial trial quality and a failed live snapshot, then serves durable replay with zero new calls', async () => {
    const f = await fixture();
    expect(await main(f.args, f.io, f.dependencies)).toBe(2);
    expect(f.stderr.join('')).toContain('PRIVATE provider failure');
    expect(f.stderr.join('')).not.toContain('Failure report unavailable');
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.observedInstructions.length).toBeGreaterThan(0);
    const count = f.observedInstructions.length;
    const root = join(f.root, 'out');
    const index = JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')) as InvocationIndex;
    expect(index).toMatchObject({ outcome: 'failed', command: 'train', phase: 'train' });
    const store = await openExperimentStore(root);
    const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'replay' })).toString()) as CliFailureReport;
    const view = await (await loadInvocationViewer(root))();
    expect(view.trials.length).toBeGreaterThan(0); expect(view.trials[0]!.checks.length).toBeGreaterThan(0);
    expect(view.experiment.status).toBe('failed');
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE|SEALED|Reply OK|BASE/);
    const viewerRun = report.progressRunId.replace(/^progress-/, 'viewer-');
    const live = await store.readReplay(viewerRun, { audience: 'viewer', phase: 'training' });
    expect(live.events.at(-1)!.payload).toMatchObject({ experiment: { status: 'failed' } });
    expect(JSON.stringify(live.events.at(-1)!.payload)).not.toMatch(/PRIVATE|SEALED|Reply OK|BASE/);
    const controller = new AbortController();
    let address!: (url: string) => void;
    const ready = new Promise<string>(resolve => { address = resolve; });
    const running = main(['view', root, '--port', '0'], { ...f.io, signal: controller.signal,
      stdout: text => { address(JSON.parse(text).viewer); } }, f.dependencies);
    const url = await ready;
    try {
      const response = await fetch(`${url}/api/data`);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(view);
    } finally { controller.abort(); }
    expect(await running).toBe(130);
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.observedInstructions).toHaveLength(count);
    const secret = await store.readReplay(report.progressRunId, { audience: 'operator', phase: 'replay' });
    const diagnostic = secret.events.find(event => event.id === report.diagnosticId)!.payload as { diagnostic: InvocationIndex['report'] };
    expect((await store.readBlob(diagnostic.diagnostic, { audience: 'operator', phase: 'replay' })).toString()).toContain('PRIVATE provider failure');
  });

  it('preserves the original error and exit when publishing the failure index is impossible', async () => {
    const f = await fixture(true);
    expect(await main(f.args, f.io, f.dependencies)).toBe(2);
    expect(f.stderr.join('')).toContain('PRIVATE provider failure');
    expect(f.stderr.join('')).toContain('Failure report unavailable; original error preserved.');
    expect(f.generate).toHaveBeenCalledOnce();
  });
  it('preserves the native error if the viewer reports a shutdown error after closing', async () => {
    const f = await fixture();
    const start = viewer.startViewer;
    vi.spyOn(viewer, 'startViewer').mockImplementation(async options => {
      const server = await start(options);
      return { ...server, close: async () => { await server.close(); throw new Error('Viewer shutdown failed'); } };
    });
    expect(await main(f.args, f.io, f.dependencies)).toBe(2);
    expect(f.stderr.join('')).toContain('PRIVATE provider failure');
    expect(f.stderr.join('')).not.toContain('Viewer shutdown failed');
    expect(JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'))).toMatchObject({ outcome: 'failed' });
  });
});
