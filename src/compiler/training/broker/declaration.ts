import path from "node:path";
import { z } from "zod";

import {
  DAIMON_GROK_BROKER_MODELS,
  DAIMON_GROK_BROKER_REASONING_EFFORTS,
  DAIMON_GROK_ENGINE_BROKER
} from "../../../runtime/daimon/contractManifest.js";

const canonical = z.string().min(2).max(4_096).refine((value) =>
  path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.endsWith("/") && !value.includes("\0"),
  "canonical absolute path");

/**
 * `spawnfile.training-broker.v1`: the only thing the host tells the
 * broker-capable training container about its slot. It is data, never code —
 * the image's own Spawnfile distribution renders the provisioning from it with
 * the same renderers production uses, so no host-written executable is ever
 * mounted (`../container/AGENTS.md`).
 *
 * It carries no credentials: the training Grok login reaches the container only
 * as the read-only bootstrap leaf bind, and the rotating credential lives on
 * the named realm volume.
 */
export const trainingBrokerDeclarationSchema = z.strictObject({
  version: z.literal("spawnfile.training-broker.v1"),
  engine: z.literal("grok"),
  agentId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  model: z.enum(DAIMON_GROK_BROKER_MODELS),
  reasoningEffort: z.enum(DAIMON_GROK_BROKER_REASONING_EFFORTS),
  architecture: z.enum(["arm64", "x64"]),
  limits: z.strictObject({
    maxRequests: z.number().int().min(DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds.maxRequests[0]).max(DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds.maxRequests[1]),
    maxTokens: z.number().int().min(DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds.maxTokens[0]).max(DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds.maxTokens[1]),
    timeoutMs: z.number().int().min(DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds.timeoutMs[0]).max(DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds.timeoutMs[1])
  }),
  /** The read-only bootstrap credential leaf, already refused if it is the desktop `~/.grok/auth.json`. */
  bootstrap: canonical,
  /** The uid the trained evaluator (Paideia, DSPy, judges) runs as; the only uid the slot supervisor serves. */
  organizationUid: z.literal(DAIMON_GROK_ENGINE_BROKER.identities.organizationUid),
  seccompProfileSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  /**
   * What the slot supervisor does with a deny path whose backing filesystem
   * does not enforce unix ownership — every host bind under Docker Desktop and
   * Colima, where `chown` is silently ignored and uid 2200 reads a root `0600`
   * file (P0 §5).
   *
   * `refuse` (the default) fails the recycle and writes no receipt: a
   * worker-uid probe over such a path carries no information, so the
   * supervisor will not certify it. `profile-only` is the operator's explicit
   * acceptance that for those paths the boundary is the bubblewrap-enforced
   * `deny` list alone — verified to block both shell `cat` and `read_file` on
   * 1.0.34 (P0 §4) — and the supervisor records every path that used that
   * weaker evidence in its log.
   */
  unenforcedBindPolicy: z.enum(["refuse", "profile-only"]).default("refuse")
}).strict();

export type TrainingBrokerDeclaration = z.infer<typeof trainingBrokerDeclarationSchema>;

export const parseTrainingBrokerDeclaration = (value: unknown): TrainingBrokerDeclaration =>
  trainingBrokerDeclarationSchema.parse(value);
