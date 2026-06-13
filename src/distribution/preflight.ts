import { SpawnfileError } from "../shared/index.js";

import type {
  DistributionReport,
  DistributionSecretCategory
} from "./types.js";

const SUPPORTED_SOURCELESS_AUTH_METHODS = new Set(["api_key", "none"]);

export interface PreflightInput {
  authValues: Record<string, string>;
  report: DistributionReport;
}

export interface PreflightResult {
  generatedSecrets: string[];
  requiredSecrets: string[];
}

const collectUnsupportedAuth = (
  report: DistributionReport
): Array<{ instance: string; method: string; provider: string; runtime: string }> => {
  const unsupported: Array<{ instance: string; method: string; provider: string; runtime: string }> = [];
  for (const instance of report.runtime_instances) {
    for (const [provider, method] of Object.entries(instance.model_auth_methods)) {
      if (!SUPPORTED_SOURCELESS_AUTH_METHODS.has(method)) {
        unsupported.push({ instance: instance.id, method, provider, runtime: instance.runtime });
      }
    }
  }
  return unsupported;
};

export const runImagePreflight = (input: PreflightInput): PreflightResult => {
  const { authValues, report } = input;

  const unsupportedAuth = collectUnsupportedAuth(report);
  if (unsupportedAuth.length > 0) {
    const detail = unsupportedAuth
      .map((entry) => `${entry.runtime}/${entry.instance} (${entry.provider}: ${entry.method})`)
      .sort()
      .join(", ");
    throw new SpawnfileError(
      "validation_error",
      `Sourceless image deployment supports only api_key model auth. Unsupported: ${detail}. ` +
        "Deploy from project source instead."
    );
  }

  const categories: DistributionSecretCategory[] = ["model", "project", "runtime", "surface"];
  const requiredSecrets = new Set<string>();
  const generatedSecrets = new Set<string>();
  for (const category of categories) {
    for (const entry of report.secrets[category]) {
      if (entry.generated) {
        generatedSecrets.add(entry.name);
        continue;
      }
      if (entry.required) {
        requiredSecrets.add(entry.name);
      }
    }
  }

  const missing = [...requiredSecrets]
    .filter((name) => {
      const value = authValues[name];
      return typeof value !== "string" || value.length === 0;
    })
    .sort();
  if (missing.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Missing required secrets for this image: ${missing.join(", ")}. ` +
        "Provide them through the selected auth profile or env file."
    );
  }

  return {
    generatedSecrets: [...generatedSecrets].sort(),
    requiredSecrets: [...requiredSecrets].sort()
  };
};
