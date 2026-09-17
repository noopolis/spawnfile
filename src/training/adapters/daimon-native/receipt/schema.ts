import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';

const absolute = z.string().min(1).refine(value => isAbsolute(value) && !value.includes(','), 'Expected absolute bind-safe path');
const nativePath = absolute.refine(value => posix.isAbsolute(value) && posix.normalize(value) === value, 'Expected canonical Linux path');
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const relative = z.string().min(1).refine(value => !posix.isAbsolute(value) && posix.normalize(value) === value &&
  value !== '..' && !value.startsWith('../') && !value.includes('\\'), 'Expected contained relative path');
const reason = z.string().trim().min(1).max(2048);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Engines a launch receipt can select. v1 receipts are always Codex. */
export const nativeEngines = z.enum(['codex', 'grok']);
/** Daimon's closed Grok broker lists; the launch records the declaration, never a default. */
export const grokModels = ['grok-4.6', 'grok-4.5', 'grok-build'] as const;
export const grokReasoningEfforts = ['low', 'medium', 'high'] as const;
/** Evaluator roots every Grok slot must deny to its worker uid (R4). */
export const grokEvaluatorRoles = ['run-root', 'context', 'sealed-inputs', 'judge-home', 'slot-ledger'] as const;

const common = {
  image: z.string().regex(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/u),
  config: absolute,
  configSha256: digest,
  sourceConfigSha256: digest,
  tokenFile: absolute,
  controlRoot: absolute,
  workerRoot: absolute,
  envFile: absolute,
  host: z.strictObject({ bindHost: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535) }),
  instructions: z.strictObject({ relativePath: relative, sha256: digest,
    rendering: z.strictObject({ kind: z.literal('trim-surround'), prefix: z.string().max(262144), suffix: z.string().max(262144), nativeSha256: digest }) }),
  workspace: z.strictObject({ source: absolute, target: nativePath }),
  projections: z.array(z.strictObject({ role: z.enum(['home', 'memory', 'transport', 'state']), source: absolute, target: nativePath })).min(1).max(24),
  bootstrap: z.strictObject({ root: absolute, entrypoint: relative }).optional(),
  limits: z.strictObject({ maxTokens: z.number().int().positive(), wakeTokenCeiling: z.number().int().positive() }),
  overrides: z.strictObject({
    schedule: z.strictObject({ before: z.record(z.string(), z.unknown()), after: z.strictObject({ kind: z.literal('disabled') }), reason }),
    selection: z.strictObject({ before: z.array(identity).min(1).max(64), after: z.array(identity).length(1), reason }),
  }),
};
const credential = z.strictObject({ source: absolute, target: nativePath });
const codexAgent = z.strictObject({ id: identity, engine: nativeEngines.extract(['codex']), model: z.string().trim().min(1).max(256) });
const grokAgent = z.strictObject({ id: identity, engine: nativeEngines.extract(['grok']), model: z.enum(grokModels), reasoningEffort: z.enum(grokReasoningEfforts) });

/**
 * The inputs Daimon's `resolveOrganizationGrokBrokerProjection` needs, plus the
 * digest the slot supervisor bound and the supervisor's receipt location.
 *
 * `denyPaths` and `profileSha256` are the provisioner's own values, carried
 * verbatim: the projection digest binds the sandbox profile bytes the root
 * supervisor actually wrote, so a party that recomputed the deny list from
 * anything else (for instance from `evaluatorPaths`, which is a subset used for
 * the canary requirement) would fork the digest and fail closed here. Every
 * party that recomputes this projection passes these same values.
 */
export const grokBrokerLaunchSchema = z.strictObject({
  projectionVersion: z.literal('noopolis.daimon.grok-broker-projection.v1'),
  projectionSha256: digest,
  slot: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  workerUid: z.number().int().min(2200).max(4_294_967_294),
  workerHomePath: nativePath,
  architecture: z.enum(['arm64', 'x64']),
  usageLedgerPath: nativePath,
  seccompProfileSha256: digest,
  profileSha256: digest,
  denyPaths: z.array(nativePath).min(1).max(64),
  limits: z.strictObject({ maxRequests: positive, maxTokens: positive, timeoutMs: positive }),
  evaluatorPaths: z.array(z.strictObject({ role: z.enum(grokEvaluatorRoles), path: nativePath })).min(grokEvaluatorRoles.length).max(64),
  /** Root slot supervisor output (`noopolis.daimon.grok-slot-preflight.v2`), written after provisioning or recycle. */
  slotPreflightReceipt: nativePath,
  /** The 32-byte hex nonce Paideia sent with this trial's recycle request; the receipt must echo it. */
  expectedNonce: digest,
  /** One above the last generation Paideia accepted for this slot (1 for an unseen slot). */
  minGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

const launchV1 = z.strictObject({ schema: z.literal('paideia.daimon-native.launch.v1'), ...common, agent: codexAgent, credentials: z.array(credential).max(1) });
const codexLaunchV2 = z.strictObject({ schema: z.literal('paideia.daimon-native.launch.v2'), ...common, agent: codexAgent, credentials: z.array(credential).max(1) });
const grokLaunchV2 = z.strictObject({ schema: z.literal('paideia.daimon-native.launch.v2'), ...common, agent: grokAgent,
  credentials: z.array(credential).max(0), broker: grokBrokerLaunchSchema });

export const nativeLaunchSchema = z.union([launchV1, codexLaunchV2, grokLaunchV2]);

export type NativeLaunch = z.infer<typeof nativeLaunchSchema>;
export type GrokNativeLaunch = z.infer<typeof grokLaunchV2>;
export type VerifiedNativeLaunch = NativeLaunch & { receiptFile: string };
export interface NativeMount { source: string; target: string; readonly: boolean }
export const containerPaths = { config: '/run/paideia/config.json', control: '/run/paideia/control',
  token: '/run/paideia/token', receipt: '/run/paideia/launch.json', worker: '/opt/paideia/native',
  bootstrap: '/opt/paideia/bootstrap' } as const;

export function isGrokLaunch<T extends NativeLaunch>(launch: T): launch is T & GrokNativeLaunch {
  return launch.agent.engine === 'grok';
}

const nested = (parent: string, child: string): boolean => child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);

export function parseNativeLaunch(value: unknown): NativeLaunch {
  const launch = nativeLaunchSchema.parse(value);
  if (launch.overrides.selection.after[0] !== launch.agent.id || !launch.overrides.selection.before.includes(launch.agent.id)) {
    throw new Error('Native selection override must retain exactly the selected declared agent');
  }
  if (launch.projections.filter(row => row.role === 'home').length !== 1) throw new Error('Exactly one fresh native home projection is required');
  if (launch.limits.wakeTokenCeiling > launch.limits.maxTokens) throw new Error('Native wake token ceiling exceeds its admitted token budget');
  if (isGrokLaunch(launch)) assertGrokBroker(launch);
  return launch;
}

function assertGrokBroker(launch: GrokNativeLaunch): void {
  const { broker } = launch;
  // A Grok slot has exactly two writable subject roots, and the projection digest binds both:
  // `workspacePath` and `runtimeHomePath`. Any further projection would be a writable root no
  // digest covers, so the union is closed here rather than filtered later.
  if (launch.projections.length !== 1) throw new Error('A Grok launch projects exactly the slot workspace and its runtime home');
  const paths = broker.evaluatorPaths.map(row => row.path);
  if (new Set(paths).size !== paths.length) throw new Error('Grok evaluator paths must be unique');
  if (new Set(broker.denyPaths).size !== broker.denyPaths.length) throw new Error('Grok deny paths must be unique');
  // The deny list is the provisioner's verbatim set the digest binds; the evaluator roots are the
  // subset the slot receipt must show as denied canaries. A root outside the deny list would be
  // certified as denied while the sandbox never masked it.
  const denied = new Set(broker.denyPaths);
  const uncovered = paths.filter(path => !denied.has(path));
  if (uncovered.length) throw new Error(`Grok evaluator roots missing from the deny list: ${uncovered.join(', ')}`);
  const missing = grokEvaluatorRoles.filter(role => !broker.evaluatorPaths.some(row => row.role === role));
  if (missing.length) throw new Error(`Grok launch omits required evaluator roots: ${missing.join(', ')}`);
  if (broker.evaluatorPaths.some(row => row.role === 'slot-ledger' && row.path !== posix.dirname(broker.usageLedgerPath))) {
    throw new Error('The Grok slot-ledger evaluator root must be the usage ledger directory');
  }
  const subject = [launch.workspace.target, ...launch.projections.map(row => row.target)];
  if (paths.some(path => subject.some(target => nested(path, target) || nested(target, path)))) {
    throw new Error('Grok evaluator roots cannot overlap subject workspace or projections');
  }
  if (broker.limits.maxTokens > launch.limits.wakeTokenCeiling) throw new Error('Grok broker token limit exceeds the launch wake ceiling');
}
