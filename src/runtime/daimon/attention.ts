import { SpawnfileError } from "../../shared/index.js";
import { hasDaimonScheduleAuthority } from "./scheduleAuthority.js";

export type DaimonAttention = Readonly<{
  maxBatchMessages: number;
  maxBatchBytes: number;
  maxExecutions?: number;
  maxTokens?: number;
}>;

const fields = {
  max_batch_messages: { target: "maxBatchMessages", minimum: 1, maximum: 32 },
  max_batch_bytes: { target: "maxBatchBytes", minimum: 1024, maximum: 12000 },
  max_executions: { target: "maxExecutions", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  max_tokens: { target: "maxTokens", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
} as const;

export const resolveDaimonAttention = (value: unknown): DaimonAttention | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpawnfileError("validation_error", "Daimon runtime option attention must be an object");
  }
  const result: Record<string, number> = { maxBatchMessages: 8, maxBatchBytes: 12000 };
  for (const [key, limit] of Object.entries(value)) {
    if (!Object.hasOwn(fields, key)) {
      throw new SpawnfileError("validation_error", `Daimon runtime option attention.${key} is unsupported`);
    }
    const field = fields[key as keyof typeof fields];
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < field.minimum || limit > field.maximum) {
      throw new SpawnfileError("validation_error", `Daimon runtime option attention.${key} must be an integer from ${field.minimum} to ${field.maximum}`);
    }
    result[field.target] = limit;
  }
  return result as DaimonAttention;
};

export const assertDaimonAttentionAuthority = async (): Promise<void> => {
  if (!await hasDaimonScheduleAuthority()) {
    throw new SpawnfileError("runtime_error", "Daimon attention is disabled: the selected image capability receipt does not attest its runtime contract");
  }
};
