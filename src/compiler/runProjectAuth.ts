import type { ImportedAuthKind, ResolvedAuthProfile } from "../auth/index.js";
import type { ContainerReport } from "../report/index.js";
import { SpawnfileError } from "../shared/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";

interface PreparedRunAuth {
  coveredModelSecrets: Set<string>;
  mountArgs: string[];
}

const MODEL_AUTH_IMPORT_KINDS: Record<string, ImportedAuthKind | null> = {
  api_key: null,
  "claude-code": "claude-code",
  codex: "codex",
  none: null
};

const addCoveredModelSecrets = (
  coveredModelSecrets: Set<string>,
  instanceId: string,
  secretNames: string[]
): void => {
  for (const secretName of secretNames) {
    coveredModelSecrets.add(`${instanceId}:${secretName}`);
  }
};

export const prepareRuntimeAuthMounts = async (
  outputDirectory: string,
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null,
  env: Record<string, string>,
  tempRoot: string
): Promise<PreparedRunAuth> => {
  if (!authProfile) {
    return { coveredModelSecrets: new Set(), mountArgs: [] };
  }

  const coveredModelSecrets = new Set<string>();
  const mountArgs: string[] = [];

  for (const instance of containerReport.runtime_instances) {
    const adapter = getRuntimeAdapter(instance.runtime);
    if (!adapter.prepareRuntimeAuth) {
      continue;
    }

    const prepared = await adapter.prepareRuntimeAuth({
      authProfile,
      env,
      instance,
      outputDirectory,
      tempRoot
    });

    addCoveredModelSecrets(coveredModelSecrets, instance.id, prepared.coveredModelSecrets);
    mountArgs.push(...prepared.mountArgs);
  }

  return { coveredModelSecrets, mountArgs };
};

export const assertDeclaredModelAuthSatisfied = (
  containerReport: ContainerReport,
  authProfile: ResolvedAuthProfile | null
): void => {
  const requiredImportKinds = new Set<ImportedAuthKind>();

  for (const instance of containerReport.runtime_instances) {
    for (const method of Object.values(instance.model_auth_methods)) {
      const importKind = MODEL_AUTH_IMPORT_KINDS[method];
      if (importKind) {
        requiredImportKinds.add(importKind);
      }
    }
  }

  if (requiredImportKinds.size === 0) {
    return;
  }

  if (!authProfile) {
    throw new SpawnfileError(
      "validation_error",
      `Auth profile is required for declared model auth methods: ${[...requiredImportKinds].sort().join(", ")}`
    );
  }

  const missingImportKinds = [...requiredImportKinds]
    .filter((kind) => !authProfile.imports[kind])
    .sort();
  if (missingImportKinds.length > 0) {
    throw new SpawnfileError(
      "validation_error",
      `Auth profile ${authProfile.name} is missing required auth imports: ${missingImportKinds.join(", ")}`
    );
  }
};
