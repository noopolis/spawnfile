import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';

const absolute = z.string().min(1).refine(value => isAbsolute(value) && !value.includes(','), 'Expected absolute bind-safe path');
const nativePath = absolute.refine(value => posix.isAbsolute(value) && posix.normalize(value) === value, 'Expected canonical Linux path');
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const relative = z.string().min(1).refine(value => !posix.isAbsolute(value) && posix.normalize(value) === value &&
  value !== '..' && !value.startsWith('../') && !value.includes('\\'), 'Expected contained relative path');
const reason = z.string().trim().min(1).max(2048);

export const nativeLaunchSchema = z.strictObject({
  schema: z.literal('paideia.daimon-native.launch.v1'),
  image: z.string().regex(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/u),
  config: absolute,
  configSha256: digest,
  sourceConfigSha256: digest,
  tokenFile: absolute,
  controlRoot: absolute,
  workerRoot: absolute,
  envFile: absolute,
  agent: z.strictObject({ id: identity, engine: z.literal('codex'), model: z.string().trim().min(1).max(256) }),
  host: z.strictObject({ bindHost: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535) }),
  instructions: z.strictObject({ relativePath: relative, sha256: digest,
    rendering: z.strictObject({ kind: z.literal('trim-surround'), prefix: z.string().max(262144), suffix: z.string().max(262144), nativeSha256: digest }) }),
  workspace: z.strictObject({ source: absolute, target: nativePath }),
  projections: z.array(z.strictObject({ role: z.enum(['home', 'memory', 'transport', 'state']), source: absolute, target: nativePath })).min(1).max(24),
  credentials: z.array(z.strictObject({ source: absolute, target: nativePath })).max(1),
  bootstrap: z.strictObject({ root: absolute, entrypoint: relative }).optional(),
  limits: z.strictObject({ maxTokens: z.number().int().positive(), wakeTokenCeiling: z.number().int().positive() }),
  overrides: z.strictObject({
    schedule: z.strictObject({ before: z.record(z.string(), z.unknown()), after: z.strictObject({ kind: z.literal('disabled') }), reason }),
    selection: z.strictObject({ before: z.array(identity).min(1).max(64), after: z.array(identity).length(1), reason }),
  }),
});

export type NativeLaunch = z.infer<typeof nativeLaunchSchema>;
export type VerifiedNativeLaunch = NativeLaunch & { receiptFile: string };
export interface NativeMount { source: string; target: string; readonly: boolean }
export const containerPaths = { config: '/run/paideia/config.json', control: '/run/paideia/control',
  token: '/run/paideia/token', receipt: '/run/paideia/launch.json', worker: '/opt/paideia/native',
  bootstrap: '/opt/paideia/bootstrap' } as const;

export function parseNativeLaunch(value: unknown): NativeLaunch {
  const launch = nativeLaunchSchema.parse(value);
  if (launch.overrides.selection.after[0] !== launch.agent.id || !launch.overrides.selection.before.includes(launch.agent.id)) {
    throw new Error('Native selection override must retain exactly the selected declared agent');
  }
  if (launch.projections.filter(row => row.role === 'home').length !== 1) throw new Error('Exactly one fresh native home projection is required');
  if (launch.limits.wakeTokenCeiling > launch.limits.maxTokens) throw new Error('Native wake token ceiling exceeds its admitted token budget');
  return launch;
}
