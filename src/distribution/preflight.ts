import { SpawnfileError } from "../shared/index.js";

import type {
  DistributionReport,
  DistributionSecretCategory
} from "./types.js";

const ENV_BASED_AUTH_METHODS = new Set(["api_key", "none"]);

// Import-based auth methods are satisfiable sourceless when the consumer has the
// matching local credential import (their logged-in Claude Code / Codex session).
const IMPORT_AUTH_METHOD_KINDS: Record<string, string> = {
  "claude-code": "claude-code",
  codex: "codex"
};

export interface PreflightInput {
  authValues: Record<string, string>;
  availableImports?: string[];
  report: DistributionReport;
}

export interface PreflightResult {
  generatedSecrets: string[];
  requiredSecrets: string[];
}

const collectUnsupportedAuth = (
  report: DistributionReport,
  availableImports: Set<string>
): Array<{ instance: string; method: string; provider: string; runtime: string }> => {
  const unsupported: Array<{ instance: string; method: string; provider: string; runtime: string }> = [];
  for (const instance of report.runtime_instances) {
    for (const [provider, method] of Object.entries(instance.model_auth_methods)) {
      if (ENV_BASED_AUTH_METHODS.has(method)) {
        continue;
      }
      const importKind = IMPORT_AUTH_METHOD_KINDS[method];
      if (importKind && availableImports.has(importKind)) {
        continue;
      }
      unsupported.push({ instance: instance.id, method, provider, runtime: instance.runtime });
    }
  }
  return unsupported;
};

export const runImagePreflight = (input: PreflightInput): PreflightResult => {
  const { authValues, report } = input;
  const availableImports = new Set(input.availableImports ?? []);

  const unsupportedAuth = collectUnsupportedAuth(report, availableImports);
  if (unsupportedAuth.length > 0) {
    const detail = unsupportedAuth
      .map((entry) => `${entry.runtime}/${entry.instance} (${entry.provider}: ${entry.method})`)
      .sort()
      .join(", ");
    throw new SpawnfileError(
      "validation_error",
      `This image needs model auth this deployment cannot provide: ${detail}. ` +
        "Provide an api_key secret, or an auth profile with the matching claude-code/codex import."
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
