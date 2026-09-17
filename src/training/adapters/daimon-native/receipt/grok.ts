import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { grokModels, grokReasoningEfforts, type GrokNativeLaunch } from './schema.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const canonical = z.string().max(4096).refine(value => posix.isAbsolute(value) && posix.normalize(value) === value &&
  value !== '/' && !value.endsWith('/') && !value.includes('\0'), 'canonical absolute path');
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Structural mirror of Daimon's public `noopolis.daimon.grok-broker-projection.v1`; Daimon stays the resolver. */
export const grokBrokerProjectionSchema = z.strictObject({
  version: z.literal('noopolis.daimon.grok-broker-projection.v1'), agentId: z.string().min(1).max(128),
  workspacePath: canonical, runtimeHomePath: canonical, workerUid: count, slot: count, profilePath: canonical, profileSha256: sha,
  denyPaths: z.array(canonical).min(1).max(256), workerConfigSha256: sha, systemPromptSha256: sha, grokCliVersion: z.string().min(1).max(64),
  grokExecutableSha256: sha, nativeAbiVersion: count, model: z.enum(grokModels), reasoningEffort: z.enum(grokReasoningEfforts),
  limits: z.strictObject({ maxRequests: count, maxTokens: count, timeoutMs: count }), usageLedgerPath: canonical, seccompProfileSha256: sha,
  attestation: z.strictObject({ platform: z.literal('linux/landlock'), enforced: z.literal(true), restrictNetwork: z.literal(true),
    profileName: z.string().min(1).max(128), sandboxRuntime: z.literal('bubblewrap'), eventsPath: canonical }),
});
export type GrokBrokerProjection = z.infer<typeof grokBrokerProjectionSchema>;

const nonce = z.string().regex(/^[a-f0-9]{64}$/u);
/**
 * Mirror of `noopolis.daimon.grok-slot-preflight.v2` at Daimon's strictness (first worker uid,
 * exact RFC3339 instant, unique canaries). The worker still verifies with Daimon's own verifier first.
 */
export const grokSlotPreflightSchema = z.strictObject({
  version: z.literal('noopolis.daimon.grok-slot-preflight.v2'), slot: count, worker_uid: z.number().int().min(2200).max(4_294_967_294),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), nonce,
  projection_sha256: sha, sandbox_profile_sha256: sha, seccomp_profile_sha256: sha, sandbox_runtime: z.literal('bubblewrap'), grok_executable_sha256: sha,
  canaries: z.array(z.strictObject({ path: canonical, method: z.literal('sandboxed-read'), result: z.literal('denied') })).min(1).max(256),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    .refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, 'exact RFC3339 timestamp'),
}).superRefine((receipt, context) => {
  const paths = receipt.canaries.map(canary => canary.path);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', path: ['canaries'], message: 'duplicate canary path' });
});
export type GrokSlotPreflight = z.infer<typeof grokSlotPreflightSchema>;

export const grokBrokerReceiptSchema = 'paideia.daimon-native.grok-broker-projection.v1';
const receiptSchema = z.strictObject({ schema: z.literal(grokBrokerReceiptSchema), trialId: z.string().min(1), configSha256: sha,
  projectionSha256: sha, projection: grokBrokerProjectionSchema, slotPreflight: grokSlotPreflightSchema });
export type GrokBrokerReceipt = z.infer<typeof receiptSchema>;

const scalars = (value: string): string => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Canonical JSON rejects unpaired surrogates');
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Canonical JSON rejects unpaired surrogates');
  }
  return JSON.stringify(value);
};

/** Daimon's canonical JSON (UTF-16 key sort, plain JSON data only); its digest is what a slot receipt binds. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return scalars(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('Canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new Error('Canonical JSON rejects sparse arrays');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Canonical JSON requires plain data');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw new Error('Canonical JSON rejects symbol keys');
  return `{${(keys as string[]).sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Canonical JSON requires data properties');
    return `${scalars(key)}:${canonicalJson(descriptor.value)}`;
  }).join(',')}}`;
}

export const grokProjectionSha256 = (projection: GrokBrokerProjection): string => createHash('sha256').update(canonicalJson(projection)).digest('hex');

const within = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * The two digest-bound writable roots a Grok launch runs the subject in.
 *
 * The trial runner protects its own layout without knowing the engine, so it
 * also names the runtime home — which for a Grok slot is the subject's own home
 * and one of the roots the projection binds as `workspacePath`/`runtimeHomePath`.
 * A caller cannot both hand the subject a root and demand the subject be denied
 * it, so these exact roots are exempt from the caller's protected set. Nothing
 * else is: a protected path *inside* one of them is still refused, because the
 * exemption matches the root itself, never a descendant.
 */
export function grokSubjectRoots(launch: GrokNativeLaunch): string[] {
  const home = launch.projections.find(row => row.role === 'home')!;
  return [...new Set([launch.workspace.source, launch.workspace.target, home.source, home.target])];
}

/** Every evaluator root a Grok launch declares, plus its control root (Daimon's acceptance store). */
export function requiredGrokEvaluatorPaths(launch: GrokNativeLaunch): string[] {
  return [...new Set([...launch.broker.evaluatorPaths.map(row => row.path), launch.controlRoot])].sort();
}

export function bindGrokBrokerProjection(projection: unknown, slotPreflight: unknown, trialId: string, configSha256: string): GrokBrokerReceipt {
  const parsed = grokBrokerProjectionSchema.parse(projection);
  return receiptSchema.parse({ schema: grokBrokerReceiptSchema, trialId, configSha256, projectionSha256: grokProjectionSha256(parsed), projection: parsed, slotPreflight });
}

/**
 * Re-binds a persisted Grok projection receipt without loading Daimon: the
 * projection must be this launch's slot, its canonical digest must equal the
 * launch and the slot receipt, the receipt must deny exactly the projected
 * paths, and every evaluator path (plus `extraRequired`) must be one of those
 * denied canaries. Launch control files must sit inside a denied root.
 */
export function parseGrokBrokerReceipt(value: unknown, launch: GrokNativeLaunch, trialId: string, extraRequired: readonly string[] = []): GrokBrokerReceipt {
  const receipt = receiptSchema.parse(value);
  const { projection, slotPreflight: slot } = receipt;
  const { broker } = launch;
  const home = launch.projections.find(row => row.role === 'home')!.target;
  const digest = grokProjectionSha256(projection);
  const mismatch = (member: string): never => { throw new Error(`Grok broker projection is not bound to this trial and launch: ${member}`); };
  if (receipt.trialId !== trialId || receipt.configSha256 !== launch.configSha256) mismatch('trial');
  if (projection.agentId !== launch.agent.id || projection.workspacePath !== launch.workspace.target || projection.runtimeHomePath !== home) mismatch('agent');
  if (projection.model !== launch.agent.model || projection.reasoningEffort !== launch.agent.reasoningEffort) mismatch('model');
  if (projection.slot !== broker.slot || projection.workerUid !== broker.workerUid || projection.usageLedgerPath !== broker.usageLedgerPath ||
    projection.seccompProfileSha256 !== broker.seccompProfileSha256 || canonicalJson(projection.limits) !== canonicalJson(broker.limits)) mismatch('slot');
  if (receipt.projectionSha256 !== digest || digest !== broker.projectionSha256 || slot.projection_sha256 !== digest) mismatch('projection_sha256');
  // Freshness: this recycle's nonce, never a generation below the evaluator's persisted floor.
  if (slot.nonce !== broker.expectedNonce) throw new Error('Grok slot preflight receipt is stale: nonce');
  if (slot.generation < broker.minGeneration) throw new Error('Grok slot preflight receipt is stale: generation');
  if (slot.slot !== projection.slot || slot.worker_uid !== projection.workerUid || slot.sandbox_profile_sha256 !== projection.profileSha256 ||
    slot.grok_executable_sha256 !== projection.grokExecutableSha256 || slot.seccomp_profile_sha256 !== projection.seccompProfileSha256) mismatch('slot_preflight');
  const denied = slot.canaries.map(canary => canary.path).sort();
  if (canonicalJson(denied) !== canonicalJson([...projection.denyPaths].sort())) mismatch('canaries');
  for (const path of [...requiredGrokEvaluatorPaths(launch), ...extraRequired]) {
    if (!denied.includes(path)) throw new Error(`Grok slot preflight omits a denied canary for evaluator path ${path}`);
  }
  for (const file of [launch.config, launch.tokenFile, launch.envFile]) {
    if (!denied.some(root => within(root, file))) throw new Error(`Grok slot preflight does not deny launch control file ${file}`);
  }
  return receipt;
}
