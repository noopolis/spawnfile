import { z } from 'zod';
import { sha256 } from './paths.js';

const absolutePath = z.string().min(1).max(4096).startsWith('/');
const projectionSchema = z.strictObject({
  version: z.literal('noopolis.daimon.codex-sandbox-projection.v1'), agentId: z.string().min(1),
  workspacePath: absolutePath, runtimeHomePath: absolutePath, engineHomePath: absolutePath, executablePath: absolutePath,
  profileName: z.string().min(1).max(128), permissionConfig: z.string().startsWith('permissions=').max(131072),
  sandboxArgs: z.array(z.string().max(131072)).length(7),
});
export type NativeSandboxProjection = z.infer<typeof projectionSchema>;
export const nativeSandboxReceiptSchema = 'paideia.daimon-native.sandbox-projection.v1';
const receiptSchema = z.strictObject({ schema: z.literal(nativeSandboxReceiptSchema), trialId: z.string().min(1),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/u), projectionSha256: z.string().regex(/^[a-f0-9]{64}$/u), projection: projectionSchema });
export type NativeSandboxReceipt = z.infer<typeof receiptSchema>;

export function parseNativeSandboxProjection(value: unknown): NativeSandboxProjection {
  const projection = projectionSchema.parse(value);
  const expected = ['sandbox', '-P', projection.profileName, '-C', projection.workspacePath, '-c', projection.permissionConfig];
  if (JSON.stringify(projection.sandboxArgs) !== JSON.stringify(expected)) throw new Error('Native sandbox projection arguments disagree with owner fields');
  return projection;
}

export function bindNativeSandboxProjection(value: unknown, trialId: string, configSha256: string): NativeSandboxReceipt {
  const projection = parseNativeSandboxProjection(value);
  return receiptSchema.parse({ schema: nativeSandboxReceiptSchema, trialId, configSha256,
    projectionSha256: sha256(JSON.stringify(projection)), projection });
}

export function parseNativeSandboxReceipt(value: unknown, expected: { trialId: string; configSha256: string; agentId: string; workspacePath: string; runtimeHomePath: string }): NativeSandboxReceipt {
  const receipt = receiptSchema.parse(value);
  const projection = parseNativeSandboxProjection(receipt.projection);
  if (receipt.trialId !== expected.trialId || receipt.configSha256 !== expected.configSha256 || projection.agentId !== expected.agentId ||
    projection.workspacePath !== expected.workspacePath || projection.runtimeHomePath !== expected.runtimeHomePath ||
    receipt.projectionSha256 !== sha256(JSON.stringify(projection))) throw new Error('Native sandbox projection is not bound to this trial and configuration');
  return receipt;
}
