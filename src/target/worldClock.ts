import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertOrdinaryJsonGraph,
  opaqueTargetHandleSchema,
  runIdSchema,
  selectedTargetSchema,
} from "./contracts.js";

export const TARGET_WORLD_CLOCK_REQUEST_VERSION =
  "spawnfile.target-world-clock.request.v1" as const;
export const TARGET_WORLD_CLOCK_RECEIPT_VERSION =
  "spawnfile.target-world-clock-receipt.v1" as const;
export const TARGET_WORLD_CLOCK_PATH = "/v1/world/clock" as const;
export const MAX_TARGET_WORLD_CLOCK_BYTES = 8_192;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const protocol = z.string().max(127).regex(/^[a-z][a-z0-9._-]*\.v[1-9][0-9]*$/u);
const clock = z.object({
  completed_tick: z.number().int().min(0).max(1_000_000_000),
  next_tick: z.number().int().min(1).max(1_000_000_001),
  state: z.literal("running"),
}).strict().superRefine((value, context) => {
  if (value.next_tick !== value.completed_tick + 1) context.addIssue({
    code: z.ZodIssueCode.custom, message: "world clock frontier is invalid",
  });
});
const observation = z.object({
  action_count: z.number().int().min(0).max(1_000_000_000),
  clock,
  run_id: runIdSchema,
  version: protocol,
  world_instance_id: runIdSchema,
}).strict();
export const targetWorldClockRequestSchema = z.object({
  activation_digest: digest,
  activation_receipt_digest: digest,
  descriptor_digest: digest,
  endpoint: z.object({
    internal_port: z.number().int().min(1).max(65_535),
    path: z.literal(TARGET_WORLD_CLOCK_PATH),
  }).strict(),
  expected: z.object({ document_version: protocol, world_instance_id: runIdSchema }).strict(),
  run_id: runIdSchema,
  selected_target: selectedTargetSchema,
  topology_receipt_digest: digest,
  topology_request_digest: digest,
  version: z.literal(TARGET_WORLD_CLOCK_REQUEST_VERSION),
  world_service_handle: opaqueTargetHandleSchema,
}).strict();
export const targetWorldClockReceiptSchema = z.object({
  action_count: z.literal(0),
  activation_digest: digest,
  activation_receipt_digest: digest,
  clock: clock.superRefine((value, context) => {
    if (value.completed_tick < 1) context.addIssue({
      code: z.ZodIssueCode.custom, message: "world has not completed its first tick",
    });
  }),
  observation_digest: digest,
  receipt_digest: digest,
  request_digest: digest,
  run_id: runIdSchema,
  topology_receipt_digest: digest,
  topology_request_digest: digest,
  version: z.literal(TARGET_WORLD_CLOCK_RECEIPT_VERSION),
  world_instance_id: runIdSchema,
  world_service_handle: opaqueTargetHandleSchema,
}).strict();

export type TargetWorldClockRequest = z.infer<typeof targetWorldClockRequestSchema>;
export type TargetWorldClockReceipt = z.infer<typeof targetWorldClockReceiptSchema>;
type ClockObservation = z.infer<typeof observation>;

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
  `sha256:${createHash("sha256").update(`${domain}\0${canonical(value)}`, "utf8").digest("hex")}`;
const parse = <Value>(schema: z.ZodType<Value>, raw: unknown): Value => {
  assertOrdinaryJsonGraph(raw);
  return schema.parse(raw);
};

export const parseTargetWorldClockRequest = (raw: unknown): TargetWorldClockRequest =>
  parse(targetWorldClockRequestSchema, raw);
export const createTargetWorldClockRequestDigest = (raw: unknown): `sha256:${string}` =>
  hash(TARGET_WORLD_CLOCK_REQUEST_VERSION, parseTargetWorldClockRequest(raw));
const parseObservation = (raw: unknown): ClockObservation => parse(observation, raw);

const bodyFor = (observed: ClockObservation, request: TargetWorldClockRequest) => {
  if (observed.action_count !== 0 || observed.clock.completed_tick < 1
    || observed.run_id !== request.run_id
    || observed.version !== request.expected.document_version
    || observed.world_instance_id !== request.expected.world_instance_id) {
    throw new TypeError("Target world clock observation correlation is invalid");
  }
  return {
    action_count: 0 as const,
    activation_digest: request.activation_digest,
    activation_receipt_digest: request.activation_receipt_digest,
    clock: observed.clock,
    observation_digest: hash("spawnfile.target-world-clock.observation.v1", observed),
    request_digest: createTargetWorldClockRequestDigest(request),
    run_id: request.run_id,
    topology_receipt_digest: request.topology_receipt_digest,
    topology_request_digest: request.topology_request_digest,
    version: TARGET_WORLD_CLOCK_RECEIPT_VERSION,
    world_instance_id: observed.world_instance_id,
    world_service_handle: request.world_service_handle,
  };
};

export const parseTargetWorldClockReceipt = (raw: unknown): TargetWorldClockReceipt => {
  const receipt = parse(targetWorldClockReceiptSchema, raw);
  const { receipt_digest: _digest, ...body } = receipt;
  if (receipt.receipt_digest !== hash(TARGET_WORLD_CLOCK_RECEIPT_VERSION, body)) {
    throw new TypeError("Target world clock receipt digest is invalid");
  }
  return receipt;
};
export const createTargetWorldClockReceipt = (input: Readonly<{
  observation: unknown; request: unknown;
}>): TargetWorldClockReceipt => {
  const body = bodyFor(parseObservation(input.observation), parseTargetWorldClockRequest(input.request));
  return parseTargetWorldClockReceipt({
    ...body, receipt_digest: hash(TARGET_WORLD_CLOCK_RECEIPT_VERSION, body),
  });
};
export const verifyTargetWorldClockReceipt = (input: Readonly<{
  receipt: unknown; request: unknown;
}>): TargetWorldClockReceipt => {
  const receipt = parseTargetWorldClockReceipt(input.receipt);
  const request = parseTargetWorldClockRequest(input.request);
  const expectedBody = bodyFor({
    action_count: receipt.action_count, clock: receipt.clock, run_id: receipt.run_id,
    version: request.expected.document_version, world_instance_id: receipt.world_instance_id,
  }, request);
  const { receipt_digest: _digest, ...body } = receipt;
  if (canonical(body) !== canonical(expectedBody)) {
    throw new TypeError("Target world clock receipt correlation is invalid");
  }
  return receipt;
};
export const createCanonicalTargetWorldClockReceiptBytes = (raw: unknown): string =>
  canonical(parseTargetWorldClockReceipt(raw));
