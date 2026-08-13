import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import {
  assertOrdinaryJsonGraph,
  selectedTargetReceiptSchema,
  type SelectedTargetReceipt
} from "../target/contracts.js";

export const SIMFILE_RUN_OPERATOR_INPUT_VERSION =
  "spawnfile.simfile-run-operator-input.v1" as const;
export const SIMFILE_RUN_OPERATOR_RESOLUTION_VERSION =
  "spawnfile.simfile-run-operator-resolution.v1" as const;
export const SIMFILE_RUN_OPERATOR_RECEIPT_VERSION =
  "spawnfile.simfile-run-operator-receipt.v1" as const;

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const releaseVersion = z.string().regex(/^v?\d+\.\d+\.\d+(?:-\d+-g[a-f0-9]{7,40})?$/u)
  .refine((value) => value !== "latest");
const absoluteRunRoot = z.string().max(4_096).refine((value) =>
  path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root);

export const simfileRunOperatorInputSchema = z.object({
  auth_profile: identifier,
  moltnet_release: z.object({
    directory_transport: z.literal("operator-path"),
    required_capability: z.literal("pi-bridge"),
    stamp_version: z.literal("spawnfile.moltnet-release-stamp.v1")
  }).strict(),
  run_id: runId,
  run_root: absoluteRunRoot,
  target_config_transport: z.literal("stdin"),
  target_selector: identifier,
  version: z.literal(SIMFILE_RUN_OPERATOR_INPUT_VERSION)
}).strict().superRefine((value, context) => {
  if (path.basename(value.run_root) !== value.run_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "run_root must be owned by run_id" });
  }
});

export const simfileRunMoltnetIdentitySchema = z.object({
  architecture: z.enum(["amd64", "arm64"]),
  asset: z.string().regex(/^moltnet_linux_(?:amd64|arm64)\.tar\.gz$/u),
  asset_sha256: digest,
  capabilities: z.tuple([z.literal("pi-bridge")]),
  release_version: releaseVersion,
  source_revision: revision,
  version: z.literal("spawnfile.moltnet-release-identity.v1")
}).strict().superRefine((value, context) => {
  if (value.asset !== `moltnet_linux_${value.architecture}.tar.gz`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Moltnet asset architecture mismatch" });
  }
  const described = value.release_version.match(/-g([a-f0-9]{7,40})$/u)?.[1];
  if (described && !value.source_revision.startsWith(described)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Moltnet source revision mismatch" });
  }
});

const runRootsSchema = z.object({
  cache: absoluteRunRoot,
  evidence: absoluteRunRoot,
  journal: absoluteRunRoot,
  output: absoluteRunRoot
}).strict();

export const simfileRunOperatorResolutionSchema = z.object({
  auth_profile: identifier,
  moltnet_release: simfileRunMoltnetIdentitySchema,
  request_digest: digest,
  roots: runRootsSchema,
  roots_digest: digest,
  run_id: runId,
  target_selector: identifier,
  version: z.literal(SIMFILE_RUN_OPERATOR_RESOLUTION_VERSION)
}).strict();

export const simfileRunOperatorReceiptSchema = z.object({
  auth_profile: identifier,
  moltnet_release: simfileRunMoltnetIdentitySchema,
  request_digest: digest,
  resolution_digest: digest,
  roots_digest: digest,
  run_id: runId,
  selected_target: selectedTargetReceiptSchema,
  target_selector: identifier,
  version: z.literal(SIMFILE_RUN_OPERATOR_RECEIPT_VERSION)
}).strict();

export type SimfileRunOperatorInput = z.infer<typeof simfileRunOperatorInputSchema>;
export type SimfileRunMoltnetIdentity = z.infer<typeof simfileRunMoltnetIdentitySchema>;
export type SimfileRunOperatorResolution = z.infer<typeof simfileRunOperatorResolutionSchema>;
export type SimfileRunOperatorReceipt = z.infer<typeof simfileRunOperatorReceiptSchema>;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const hash = (domain: string, value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(`${domain}\0${canonical(value)}`).digest("hex")}`;
const parse = <Value>(schema: z.ZodType<Value>, raw: unknown): Value => {
  assertOrdinaryJsonGraph(raw);
  return schema.parse(raw);
};

export const parseSimfileRunOperatorInput = (raw: unknown): SimfileRunOperatorInput =>
  parse(simfileRunOperatorInputSchema, raw);
export const parseSimfileRunOperatorResolution = (raw: unknown): SimfileRunOperatorResolution =>
  parse(simfileRunOperatorResolutionSchema, raw);
export const parseSimfileRunOperatorReceipt = (raw: unknown): SimfileRunOperatorReceipt =>
  parse(simfileRunOperatorReceiptSchema, raw);

export const createSimfileRunOperatorRequestDigest = (raw: unknown): `sha256:${string}` =>
  hash(SIMFILE_RUN_OPERATOR_INPUT_VERSION, parseSimfileRunOperatorInput(raw));

export const resolveSimfileRunOperatorInput = (input: {
  readonly request: unknown;
  readonly moltnet_release: unknown;
}): SimfileRunOperatorResolution => {
  const request = parseSimfileRunOperatorInput(input.request);
  const moltnetRelease = parse(simfileRunMoltnetIdentitySchema, input.moltnet_release);
  const roots = {
    cache: path.join(request.run_root, "cache"),
    evidence: path.join(request.run_root, "evidence"),
    journal: path.join(request.run_root, "journal"),
    output: path.join(request.run_root, "output")
  };
  return parseSimfileRunOperatorResolution({
    auth_profile: request.auth_profile,
    moltnet_release: moltnetRelease,
    request_digest: createSimfileRunOperatorRequestDigest(request),
    roots,
    roots_digest: hash("spawnfile.simfile-run-roots.v1", roots),
    run_id: request.run_id,
    target_selector: request.target_selector,
    version: SIMFILE_RUN_OPERATOR_RESOLUTION_VERSION
  });
};

export const createSimfileRunOperatorReceipt = (input: {
  readonly resolution: unknown;
  readonly selected_target: SelectedTargetReceipt;
}): SimfileRunOperatorReceipt => {
  const resolution = parseSimfileRunOperatorResolution(input.resolution);
  const selectedTarget = parse(selectedTargetReceiptSchema, input.selected_target);
  return parseSimfileRunOperatorReceipt({
    auth_profile: resolution.auth_profile,
    moltnet_release: resolution.moltnet_release,
    request_digest: resolution.request_digest,
    resolution_digest: hash(SIMFILE_RUN_OPERATOR_RESOLUTION_VERSION, resolution),
    roots_digest: resolution.roots_digest,
    run_id: resolution.run_id,
    selected_target: selectedTarget,
    target_selector: resolution.target_selector,
    version: SIMFILE_RUN_OPERATOR_RECEIPT_VERSION
  });
};

export const verifySimfileRunOperatorReceipt = (input: {
  readonly receipt: unknown;
  readonly resolution: unknown;
  readonly selected_target: SelectedTargetReceipt;
}): SimfileRunOperatorReceipt => {
  const receipt = parseSimfileRunOperatorReceipt(input.receipt);
  const expected = createSimfileRunOperatorReceipt({
    resolution: input.resolution,
    selected_target: input.selected_target
  });
  if (canonical(receipt) !== canonical(expected)) {
    throw new TypeError("Simfile run operator receipt correlation is invalid");
  }
  return receipt;
};
