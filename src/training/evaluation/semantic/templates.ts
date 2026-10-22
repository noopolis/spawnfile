import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { TrainingJudge } from '../../contracts/training-config.js';

type JudgeTemplate = NonNullable<TrainingJudge['template']>;
const enginePath = createRequire(import.meta.url).resolve('@huggingface/jinja');
const maximumSourceBytes = 32_768;
const maximumRubricBytes = 131_072;
const maximumOutputBytes = 262_144;
const timeoutMs = 1000;

// The worker loads the pinned real engine. No subject data or callable host values
// enter its template context. Isolation bounds expensive authored loops and macros.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const { Template } = require(workerData.enginePath);
  const template = new Template(workerData.text);
  const nodes = [template.parsed];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'Identifier' && node.value === 'strftime_now') throw new Error();
    nodes.push(...Object.values(node));
  }
  const text = workerData.validate ? '' : template.render({ rubric: workerData.rubric });
  if (Buffer.byteLength(text, 'utf8') > workerData.maximumOutputBytes) throw new Error();
  parentPort.postMessage({ ok: true, text });
} catch {
  parentPort.postMessage({ ok: false });
}
`;

/** Validate syntax without executing authored loops, filters or macros. */
export async function validateJudgeTemplate(template: JudgeTemplate, signal?: AbortSignal): Promise<void> {
  await execute(template, '', true, signal);
}

/** Render trusted judge instructions; evidence is appended separately by the evaluator. */
export async function renderJudgeTemplate(template: JudgeTemplate, rubric: string, signal?: AbortSignal): Promise<string> {
  return execute(template, rubric, false, signal);
}

async function execute(template: JudgeTemplate, rubric: string, validate: boolean, signal?: AbortSignal): Promise<string> {
  if (template.language !== 'jinja' || !template.text.trim() ||
    Buffer.byteLength(template.text, 'utf8') > maximumSourceBytes ||
    Buffer.byteLength(rubric, 'utf8') > maximumRubricBytes) {
    throw new Error('Invalid or oversized judge template input');
  }
  if (signal?.aborted) throw new Error('Judge template rendering cancelled');
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { enginePath, text: template.text, rubric, validate, maximumOutputBytes },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const failed = () => reject(new Error('Judge template rendering failed'));
      cancel = () => reject(new Error('Judge template rendering cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      worker.once('error', failed);
      worker.once('exit', failed);
      worker.once('message', (result: { ok: boolean; text?: string }) => {
        if (result.ok && typeof result.text === 'string') resolve(result.text);
        else failed();
      });
      timer = setTimeout(() => reject(new Error('Judge template rendering timed out')), timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
    await worker.terminate();
  }
}
