import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { z } from "zod";

import type { OrganizationReadinessEvidence } from "../compiler/organizationReadyEvidence.js";
import type { DockerUnitInspection } from "./dockerInspect.js";

export const ORGANIZATION_READY_VERSION = "spawnfile.organization-ready.v1" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const FINGERPRINT = /^sf1:[a-f0-9]{12}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

const codes = [
  "organization_ready",
  "external_moltnet",
  "compiled_evidence_missing",
  "unit_unavailable",
  "unit_restarted",
  "probe_unavailable",
  "identity_mismatch",
  "topology_mismatch",
  "probe_timeout",
  "probe_cancelled"
] as const;

export type OrganizationReadyCode = (typeof codes)[number];
export type OrganizationReadyState = "ready" | "pending" | "failed" | "cancelled";

export interface OrganizationReadiness {
  readonly version: typeof ORGANIZATION_READY_VERSION;
  readonly run_id: string | null;
  readonly compile_fingerprint: string;
  readonly unit_id: string;
  readonly world_binding_digest: string | null;
  readonly state: OrganizationReadyState;
  readonly code: OrganizationReadyCode;
  readonly reason?: string;
}

interface ExactOrganizationReadinessInput {
  readonly code: OrganizationReadyCode;
  readonly compileFingerprint: string;
  readonly runId: string | null;
  readonly state: OrganizationReadyState;
  readonly unitId: string;
  readonly worldBindingDigest: string | null;
  readonly reason?: string;
}

export interface OrganizationReadinessProbeData {
  readonly configs: ReadonlyMap<string, string>;
  readonly networks: readonly {
    readonly healthOk: boolean;
    readonly id: string;
  }[];
  readonly worldBindings: string | null;
}

export interface ReconcileOrganizationReadinessInput {
  readonly evidence: OrganizationReadinessEvidence;
  readonly inspection: DockerUnitInspection | null;
  readonly record: {
    readonly compileFingerprint: string;
    readonly deploymentName: string;
    readonly runId: string | null;
    readonly unitCount: number;
    readonly unitId: string;
  };
  readonly probe: OrganizationReadinessProbeData | null;
}

type PlainRecord = Record<string, unknown>;

const isPlainRecord = (value: unknown): value is PlainRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && !nodeTypes.isProxy(value);

const organizationReadinessObjectSchema = z.object({
  code: z.union([
    z.literal("organization_ready"), z.literal("external_moltnet"),
    z.literal("compiled_evidence_missing"), z.literal("unit_unavailable"),
    z.literal("unit_restarted"), z.literal("probe_unavailable"),
    z.literal("identity_mismatch"), z.literal("topology_mismatch"),
    z.literal("probe_timeout"), z.literal("probe_cancelled")
  ]),
  compile_fingerprint: z.string(),
  run_id: z.string().nullable(),
  state: z.union([
    z.literal("ready"), z.literal("pending"), z.literal("failed"), z.literal("cancelled")
  ]),
  unit_id: z.string(),
  version: z.literal(ORGANIZATION_READY_VERSION),
  world_binding_digest: z.string().nullable(),
  reason: z.string().min(1).max(512).optional()
}).strict().superRefine((result, context) => {
  if (!FINGERPRINT.test(result.compile_fingerprint)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["compile_fingerprint"], message: "invalid fingerprint" });
  }
  if (!ID.test(result.unit_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unit_id"], message: "invalid unit id" });
  }
  if (result.run_id !== null && !ID.test(result.run_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["run_id"], message: "invalid run id" });
  }
  if (result.world_binding_digest !== null && !DIGEST.test(result.world_binding_digest)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["world_binding_digest"], message: "invalid digest" });
  }
  if (!validStateCode(result.state, result.code)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "invalid state/code combination" });
  }
  if (result.state === "ready" && (result.run_id === null || result.world_binding_digest === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "ready requires run_id and world_binding_digest" });
  }
});

export const organizationReadinessSchema = z.preprocess(
  (value) => isPlainRecord(value) ? value : null,
  organizationReadinessObjectSchema
);

const exact = (value: unknown, fields: readonly string[]): PlainRecord | null => {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  return keys.length === fields.length
    && keys.every((key) => fields.includes(key))
    && fields.every((field) => Object.hasOwn(value, field))
    ? value
    : null;
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length
  && new Set(left).size === left.length
  && new Set(right).size === right.length
  && left.every((entry) => right.includes(entry));

const create = (input: ExactOrganizationReadinessInput): OrganizationReadiness => ({
  code: input.code,
  compile_fingerprint: input.compileFingerprint,
  run_id: input.runId,
  state: input.state,
  unit_id: input.unitId,
  version: ORGANIZATION_READY_VERSION,
  world_binding_digest: input.worldBindingDigest,
  ...(input.reason ? { reason: input.reason } : {})
});

const correlation = (
  evidence: OrganizationReadinessEvidence,
  record: ReconcileOrganizationReadinessInput["record"],
  state: OrganizationReadyState,
  code: OrganizationReadyCode
): OrganizationReadiness =>
  create({
    code,
    compileFingerprint: evidence.compileFingerprint,
    runId: record.runId,
    state,
    unitId: record.unitId,
    worldBindingDigest: evidence.worldBindings?.digest ?? null
  });

const validStateCode = (state: OrganizationReadyState, code: OrganizationReadyCode): boolean =>
  (state === "ready" && code === "organization_ready")
  || (state === "pending" && [
    "external_moltnet", "compiled_evidence_missing", "unit_unavailable", "unit_restarted", "probe_unavailable"
  ].includes(code))
  || (state === "failed" && ["identity_mismatch", "topology_mismatch", "probe_timeout"].includes(code))
  || (state === "cancelled" && code === "probe_cancelled");

export const createOrganizationReadinessPending = (
  evidence: OrganizationReadinessEvidence,
  record: ReconcileOrganizationReadinessInput["record"]
): OrganizationReadiness =>
  correlation(
    evidence,
    record,
    "pending",
    evidence.hasExternalMoltnet ? "external_moltnet" : evidence.worldBindings ? "probe_unavailable" : "compiled_evidence_missing"
  );

export const parseOrganizationReadiness = (value: unknown): OrganizationReadiness => {
  const parsed = organizationReadinessSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid ${ORGANIZATION_READY_VERSION}`);
  }
  const result: OrganizationReadiness = {
    code: parsed.data.code,
    compile_fingerprint: parsed.data.compile_fingerprint,
    run_id: parsed.data.run_id,
    state: parsed.data.state,
    unit_id: parsed.data.unit_id,
    version: ORGANIZATION_READY_VERSION,
    world_binding_digest: parsed.data.world_binding_digest,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {})
  };
  return result;
};

const hash = (content: string): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

const validNodeConfig = (content: string | undefined, expectedDigest: string): boolean => {
  if (!content || hash(content) !== expectedDigest) return false;
  try {
    const config = JSON.parse(content);
    return isPlainRecord(config) && config.version === "moltnet.node.v1";
  } catch {
    return false;
  }
};

const validBindings = (
  evidence: OrganizationReadinessEvidence,
  content: string | null
): boolean => {
  if (!content || !evidence.worldBindings || hash(content) !== evidence.worldBindings.digest) return false;
  try {
    const body = exact(JSON.parse(content), ["schema", "bindings"]);
    if (!body || body.schema !== evidence.worldBindings.schema || !Array.isArray(body.bindings)) return false;
    const members = body.bindings.map((entry) => {
      const binding = exact(entry, [
        "member", "run_id", "world_instance_id", "capability_manifest_digest", "token_env", "json", "mcp"
      ]);
      const member = binding ? exact(binding.member, ["id", "principal_id"]) : null;
      return member && typeof member.id === "string" && member.principal_id === `agent:${member.id}` && ID.test(member.id)
        ? member.id
        : null;
    });
    return members.every((member) => member !== null)
      && sameSet(members as string[], evidence.worldBindings.assignments.map((assignment) => assignment.memberId));
  } catch {
    return false;
  }
};

export const reconcileOrganizationReadiness = (
  input: ReconcileOrganizationReadinessInput
): OrganizationReadiness => {
  const { evidence, inspection, record } = input;
  if (evidence.hasExternalMoltnet) return correlation(evidence, record, "pending", "external_moltnet");
  if (!evidence.worldBindings || !record.runId) return correlation(evidence, record, "pending", "compiled_evidence_missing");
  if (record.unitCount !== 1 || !inspection || inspection.running !== true || inspection.exists !== true) {
    return correlation(evidence, record, "pending", "unit_unavailable");
  }
  if (inspection.restartCount !== 0) return correlation(evidence, record, "pending", "unit_restarted");
  const identity = inspection.identity;
  if (!identity) return correlation(evidence, record, "pending", "probe_unavailable");
  if (inspection.drift.length > 0 || record.compileFingerprint !== evidence.compileFingerprint
    || identity.compileFingerprint !== evidence.compileFingerprint || identity.deployment !== record.deploymentName
    || identity.project !== evidence.projectLabel || identity.runId !== record.runId
    || identity.unit !== record.unitId || identity.version !== evidence.compileVersion) {
    return correlation(evidence, record, "failed", "identity_mismatch");
  }
  if (!input.probe || input.probe.networks.length !== evidence.networks.length
    || !evidence.networks.every((network) => {
      const live = input.probe?.networks.find((candidate) => candidate.id === network.id);
      return live?.healthOk === true;
    })
    || !evidence.networks.every((network) => network.nodes.every((node) =>
      validNodeConfig(input.probe!.configs.get(node.configPath), node.sha256)))
    || !validBindings(evidence, input.probe.worldBindings)) {
    return correlation(evidence, record, "failed", "topology_mismatch");
  }
  return correlation(evidence, record, "ready", "organization_ready");
};

export const organizationReadinessFromProbeError = (
  evidence: OrganizationReadinessEvidence,
  record: ReconcileOrganizationReadinessInput["record"],
  error: unknown
): OrganizationReadiness => {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "TimeoutError" || /timeout|timed out/iu.test(message)) {
    return { ...correlation(evidence, record, "failed", "probe_timeout"), reason: boundedReadinessReason(message) };
  }
  if (name === "AbortError" || /cancel|abort/iu.test(message)) {
    return { ...correlation(evidence, record, "cancelled", "probe_cancelled"), reason: boundedReadinessReason(message) };
  }
  if (/\bHTTP 4\d{2}\b/iu.test(message)) {
    return { ...correlation(evidence, record, "failed", "topology_mismatch"), reason: boundedReadinessReason(message) };
  }
  return { ...correlation(evidence, record, "pending", "probe_unavailable"), reason: boundedReadinessReason(message) };
};

const boundedReadinessReason = (message: string): string => message
  .replace(/\s+/gu, " ")
  .replace(/(bearer|token|password|passwd|secret|authorization)[=: ]+(?:bearer[ ]+)?[^ ]+/giu, "$1=[redacted]")
  .replace(/https?:\/\/[^ ]+/giu, "[url redacted]")
  .slice(0, 512) || "probe unavailable";
