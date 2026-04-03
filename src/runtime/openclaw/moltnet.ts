import type { RuntimeContainerConfigEnvBinding } from "../types.js";

export interface OpenClawMoltnetRuntimeOptions {
  baseUrl?: string;
  enabled?: boolean;
  networkId?: string;
  token?: string;
  tokenSecret?: string;
  timeoutMs?: number;
}

const MOLTNET_OPTION_KEYS = new Set([
  "base_url",
  "enabled",
  "network_id",
  "timeout_ms",
  "token",
  "token_secret"
]);

const parseMoltnetOptions = (
  options: Record<string, unknown>
): { errors: string[]; value?: OpenClawMoltnetRuntimeOptions } => {
  const raw = options.moltnet;
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      errors: [
        "OpenClaw runtime option moltnet must be an object with enabled/base_url/network_id/timeout_ms/token/token_secret"
      ]
    };
  }

  const value = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!MOLTNET_OPTION_KEYS.has(key)) {
      errors.push(`OpenClaw runtime option moltnet.${key} is unsupported`);
    }
  }

  const parsed: OpenClawMoltnetRuntimeOptions = {};

  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") {
      errors.push("OpenClaw runtime option moltnet.enabled must be a boolean");
    } else {
      parsed.enabled = value.enabled;
    }
  }

  if ("base_url" in value) {
    if (typeof value.base_url !== "string" || value.base_url.trim().length === 0) {
      errors.push("OpenClaw runtime option moltnet.base_url must be a non-empty string");
    } else {
      try {
        const url = new URL(value.base_url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          errors.push("OpenClaw runtime option moltnet.base_url must use http or https");
        } else {
          parsed.baseUrl = value.base_url.trim().replace(/\/+$/, "");
        }
      } catch {
        errors.push("OpenClaw runtime option moltnet.base_url must be a valid URL");
      }
    }
  }

  if ("network_id" in value) {
    if (typeof value.network_id !== "string" || value.network_id.trim().length === 0) {
      errors.push("OpenClaw runtime option moltnet.network_id must be a non-empty string");
    } else {
      parsed.networkId = value.network_id.trim();
    }
  }

  if ("timeout_ms" in value) {
    if (
      typeof value.timeout_ms !== "number" ||
      !Number.isInteger(value.timeout_ms) ||
      value.timeout_ms <= 0
    ) {
      errors.push("OpenClaw runtime option moltnet.timeout_ms must be a positive integer");
    } else {
      parsed.timeoutMs = value.timeout_ms;
    }
  }

  if ("token" in value) {
    if (typeof value.token !== "string" || value.token.trim().length === 0) {
      errors.push("OpenClaw runtime option moltnet.token must be a non-empty string");
    } else {
      parsed.token = value.token.trim();
    }
  }

  if ("token_secret" in value) {
    if (typeof value.token_secret !== "string" || value.token_secret.trim().length === 0) {
      errors.push("OpenClaw runtime option moltnet.token_secret must be a non-empty string");
    } else {
      parsed.tokenSecret = value.token_secret.trim();
    }
  }

  if (parsed.enabled === true && !parsed.baseUrl) {
    errors.push("OpenClaw runtime option moltnet.base_url is required when moltnet.enabled=true");
  }

  if (parsed.token && parsed.tokenSecret) {
    errors.push("OpenClaw runtime option moltnet must not declare both token and token_secret");
  }

  return errors.length > 0 ? { errors } : { errors, value: parsed };
};

export const validateOpenClawMoltnetRuntimeOptions = (
  options: Record<string, unknown>
): string[] => parseMoltnetOptions(options).errors;

export const buildOpenClawMoltnetConfig = (
  options: Record<string, unknown>
): Record<string, unknown> | undefined => {
  const parsed = parseMoltnetOptions(options);
  if (parsed.errors.length > 0 || !parsed.value) {
    return undefined;
  }

  const config = {
    ...(parsed.value.enabled !== undefined ? { enabled: parsed.value.enabled } : {}),
    ...(parsed.value.baseUrl ? { baseUrl: parsed.value.baseUrl } : {}),
    ...(parsed.value.networkId ? { networkId: parsed.value.networkId } : {}),
    ...(parsed.value.timeoutMs !== undefined ? { timeoutMs: parsed.value.timeoutMs } : {}),
    ...(parsed.value.token ? { token: parsed.value.token } : {})
  };

  return Object.keys(config).length > 0 ? config : undefined;
};

export const buildOpenClawMoltnetEnvBindings = (
  options: Record<string, unknown>
): RuntimeContainerConfigEnvBinding[] | undefined => {
  const parsed = parseMoltnetOptions(options);
  if (parsed.errors.length > 0 || !parsed.value?.tokenSecret) {
    return undefined;
  }

  return [
    {
      envName: parsed.value.tokenSecret,
      jsonPath: "moltnet.token"
    }
  ];
};
