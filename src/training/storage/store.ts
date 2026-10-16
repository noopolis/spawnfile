import { readdir } from 'node:fs/promises';
import type { BlobReference, ExperimentStore, ReadAccess, RunManifest, StoredEvaluation, Visibility } from './types.js';
import { assertIdentity, contentDigest, digestName, identity, jsonBytes } from './content.js';
import { immutableWrite, initializeStoreRoot, readStored, safeStorePath } from './filesystem.js';
import { appendJournal, readJournal } from './journal.js';
import { assertRunAccess, canReadVisibility, validateManifest, validateVisibility } from './permissions.js';
import { externalizeEvaluationJson, hydrateEvaluationJson } from './evaluation-json.js';

interface BlobMetadata extends BlobReference { visibility: Visibility }
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  queues.set(key, pending);
  void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => undefined);
  return pending;
}
export async function openExperimentStore(rootPath: string): Promise<ExperimentStore> {
  const root = await initializeStoreRoot(rootPath);
  function runParts(runId: string): string[] {
    assertIdentity(runId);
    return ['runs', digestName(contentDigest(runId))];
  }
  async function runPath(runId: string, ...suffix: string[]): Promise<string> {
    return safeStorePath(root, [...runParts(runId), ...suffix]);
  }
  async function readRun(runId: string): Promise<RunManifest> {
    const stored = JSON.parse((await readStored(await runPath(runId, 'manifest.json'))).toString('utf8')) as { manifest: RunManifest; digest: string };
    validateManifest(stored.manifest);
    if (stored.manifest.id !== runId || identity(stored.manifest) !== stored.digest) throw new Error('Stored run manifest integrity mismatch');
    return stored.manifest;
  }
  async function authorize(runId: string, access: ReadAccess): Promise<RunManifest> {
    const manifest = await readRun(runId);
    assertRunAccess(manifest, access);
    return manifest;
  }
  const store: ExperimentStore = {
    async createRun(manifest) {
      validateManifest(manifest);
      await immutableWrite(await runPath(manifest.id, 'manifest.json'), jsonBytes({ manifest, digest: identity(manifest) }));
    },
    async putBlob(runId, bytes, visibility = 'evaluator') {
      await readRun(runId);
      validateVisibility(visibility);
      const content = Buffer.from(bytes);
      const digest = contentDigest(content);
      const body = { runId, digest, size: content.length, visibility };
      const record = { ...body, id: identity(body) };
      await immutableWrite(await safeStorePath(root, ['blobs', digestName(digest)]), content);
      await immutableWrite(await runPath(runId, 'blobs', `${digestName(record.id)}.json`), jsonBytes(record));
      return { runId, id: record.id, digest, size: content.length };
    },
    async listBlobs(runId, access) {
      await authorize(runId, access);
      let names: string[];
      try { names = await readdir(await runPath(runId, 'blobs')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
      const references: (BlobReference & { visibility: Visibility })[] = [];
      for (const name of names.filter(name => name.endsWith('.json')).sort()) {
        const metadata = JSON.parse((await readStored(await runPath(runId, 'blobs', name))).toString('utf8')) as BlobMetadata;
        const { id, ...body } = metadata;
        validateVisibility(metadata.visibility);
        if (id !== identity(body) || name !== `${digestName(id)}.json` || metadata.runId !== runId ||
            !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > 67_108_864) {
          throw new Error('Blob reference integrity mismatch');
        }
        if (canReadVisibility(metadata.visibility, access)) references.push({ runId, id, digest: metadata.digest, size: metadata.size, visibility: metadata.visibility });
      }
      return references;
    },
    async readBlob(reference, access) {
      await authorize(reference.runId, access);
      const metadata = JSON.parse((await readStored(await runPath(reference.runId, 'blobs', `${digestName(reference.id)}.json`))).toString('utf8')) as BlobMetadata;
      const { id, ...body } = metadata;
      if (id !== identity(body) || id !== reference.id || metadata.runId !== reference.runId || metadata.digest !== reference.digest || metadata.size !== reference.size) throw new Error('Blob reference integrity mismatch');
      if (!canReadVisibility(metadata.visibility, access)) throw new Error('Protected blob access denied');
      const bytes = await readStored(await safeStorePath(root, ['blobs', digestName(metadata.digest)]));
      if (bytes.length !== metadata.size || contentDigest(bytes) !== metadata.digest) throw new Error('Stored blob content is corrupt');
      return bytes;
    },
    async appendEvent(runId, event, visibility = 'raw') {
      const manifest = await readRun(runId);
      jsonBytes(event.payload);
      const path = await runPath(runId, 'events.jsonl');
      const payload = await externalizeEvaluationJson(store, runId, event.payload, visibility);
      return serialized(path, () => appendJournal(path, { ...event, payload }, visibility, async (left, right) => {
        const access: ReadAccess = { audience: 'operator', phase: 'test', frozenCandidateIds: [manifest.candidateId] };
        return jsonBytes(await hydrateEvaluationJson(store, left, access)) === jsonBytes(await hydrateEvaluationJson(store, right, access));
      }));
    },
    async appendEvaluation(runId, evaluation, visibility = 'evaluator') {
      const manifest = await readRun(runId);
      assertIdentity(evaluation.id);
      jsonBytes(evaluation.report);
      validateVisibility(visibility);
      const path = await runPath(runId, 'evaluations', `${digestName(contentDigest(evaluation.id))}.json`);
      let previous: StoredEvaluation | undefined;
      try {
        previous = JSON.parse((await readStored(path)).toString('utf8')) as StoredEvaluation;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (previous) {
        const { digest, ...body } = previous;
        if (identity(body) !== digest || previous.id !== evaluation.id) throw new Error('Stored evaluation integrity mismatch');
        const access: ReadAccess = { audience: 'operator', phase: 'test', frozenCandidateIds: [manifest.candidateId] };
        if (previous.visibility !== visibility || jsonBytes(await hydrateEvaluationJson(store, previous.report, access)) !== jsonBytes(evaluation.report)) {
          throw new Error('Immutable stored identity already has different bytes');
        }
        return;
      }
      const report = await externalizeEvaluationJson(store, runId, evaluation.report, visibility);
      const body = { ...evaluation, report, visibility };
      await immutableWrite(path, jsonBytes({ ...body, digest: identity(body) }));
    },
    async readReplay(runId, access) {
      const manifest = await authorize(runId, access);
      const journal = await readJournal(await runPath(runId, 'events.jsonl'));
      const events = await Promise.all(journal.events.filter(event => canReadVisibility(event.visibility, access))
        .map(async event => ({ ...event, payload: await hydrateEvaluationJson(store, event.payload, access) })));
      const directory = await runPath(runId, 'evaluations');
      let names: string[];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
      const evaluations: StoredEvaluation[] = [];
      for (const name of names.filter(name => name.endsWith('.json')).sort()) {
        const report = JSON.parse((await readStored(await runPath(runId, 'evaluations', name))).toString('utf8')) as StoredEvaluation;
        const { digest, ...body } = report;
        assertIdentity(report.id);
        if (identity(body) !== digest || name !== `${digestName(contentDigest(report.id))}.json`) throw new Error('Stored evaluation integrity mismatch');
        if (canReadVisibility(report.visibility, access)) evaluations.push({ ...report,
          report: await hydrateEvaluationJson(store, report.report, access) });
      }
      const redactedMetadata = manifest.metadata !== undefined && !canReadVisibility('evaluator', access);
      const { metadata: _metadata, ...publicManifest } = manifest;
      return { manifest: redactedMetadata ? publicManifest : manifest, redactedMetadata, events, evaluations, completeness: journal.ignoredTailBytes ? 'torn-tail' : 'complete',
        ignoredTailBytes: journal.ignoredTailBytes, redactedEvents: journal.events.length - events.length };
    },
  };
  return store;
}
