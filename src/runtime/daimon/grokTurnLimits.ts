import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_GROK_ENGINE_BROKER } from "./contractManifest.js";

export type DaimonGrokTurnLimits = Readonly<{
  maxRequests?: number;
  maxTokens?: number;
  timeoutMs?: number;
}>;

const bounds = DAIMON_GROK_ENGINE_BROKER.turnLimits.bounds;

const fields = {
  max_requests: { target: "maxRequests", range: bounds.maxRequests },
  max_tokens: { target: "maxTokens", range: bounds.maxTokens },
  timeout_ms: { target: "timeoutMs", range: bounds.timeoutMs }
} as const;

/**
 * A brokered Grok agent's per-turn budget, declared on the agent rather than inherited.
 *
 * Undeclared, a registration takes the contract's `turnLimits.v1Defaults`
 * (32 requests / 300k tokens / 240s) — which is also the ceiling a wake may lower to, so a
 * production organization carrying the Codex-era per-wake ceilings had every Grok turn
 * refused as `invalid_request` before it began: the broker accepts a wake that lowers its
 * registration's limits and refuses one that raises them. The declaration exists so an
 * organization can state the budget it actually wants instead of silently living at four
 * minutes a turn. The bounds are the contract manifest's own, so a declaration can never
 * exceed what the broker will honour, and every key stays optional: what is not declared
 * keeps the default.
 */
export const resolveDaimonGrokTurnLimits = (value: unknown): DaimonGrokTurnLimits | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpawnfileError("validation_error", "Daimon runtime option turn_limits must be an object");
  }
  const result: Record<string, number> = {};
  for (const [key, limit] of Object.entries(value)) {
    if (!Object.hasOwn(fields, key)) {
      throw new SpawnfileError("validation_error", `Daimon runtime option turn_limits.${key} is unsupported`);
    }
    const field = fields[key as keyof typeof fields];
    const [minimum, maximum] = field.range;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < minimum || limit > maximum) {
      throw new SpawnfileError(
        "validation_error",
        `Daimon runtime option turn_limits.${key} must be an integer from ${minimum} to ${maximum}`
      );
    }
    result[field.target] = limit;
  }
  if (Object.keys(result).length === 0) {
    throw new SpawnfileError("validation_error", "Daimon runtime option turn_limits must declare at least one limit");
  }
  return result as DaimonGrokTurnLimits;
};

/** The registration's limits: the contract defaults, lowered or raised only by what the agent declared. */
export const resolveDaimonGrokRegistrationLimits = (
  declared: DaimonGrokTurnLimits | undefined
): { maxRequests: number; maxTokens: number; timeoutMs: number } => ({
  ...DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults,
  ...(declared?.maxRequests === undefined ? {} : { maxRequests: declared.maxRequests }),
  ...(declared?.maxTokens === undefined ? {} : { maxTokens: declared.maxTokens }),
  ...(declared?.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs })
});
