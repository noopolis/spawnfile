import path from "node:path";

import { loadImportedClaudeCodeCredential, loadImportedCodexCredential, type ResolvedAuthProfile } from "../auth/index.js";
import { fileExists } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/errors.js";
import { getRuntimeAdapter, hasRuntimeAdapter, isBundledRuntimeAdapter } from "./registry.js";
import type { RuntimeHomeAuthMethod } from "./types.js";

interface RuntimeImportInstance {
  home_path: string | null;
  id: string;
  model_auth_methods: Record<string, string>;
  runtime: string;
}

export interface RuntimeHomeImport {
  method: RuntimeHomeAuthMethod;
  source: string;
  targets: string[];
}

const methods = ["claude-code", "codex"] as const;

export const requestsRuntimeHomeImport = (instance: RuntimeImportInstance, method: RuntimeHomeAuthMethod): boolean => {
  if (!hasRuntimeAdapter(instance.runtime)) return false;
  const supported = getRuntimeAdapter(instance.runtime).container.rawHomeAuthImports;
  const declared = instance.model_auth_methods;
  return Array.isArray(supported) && supported.includes(method)
    && typeof declared === "object" && declared !== null && !Array.isArray(declared)
    && Object.values(declared).includes(method);
};

const canonicalHome = (instance: RuntimeImportInstance): string | null => {
  const home = instance.home_path;
  if (home === null) return null;
  if (typeof home !== "string" || home === "/" || !home.startsWith("/")
    || /[:\u0000-\u0020\u007f\\]/u.test(home) || path.posix.normalize(home) !== home
    || home.endsWith("/")) {
    throw new SpawnfileError("validation_error", `Invalid runtime home for credential routing: ${instance.id}`);
  }
  return home;
};

const overlaps = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

export const resolveRuntimeHomeImports = (
  instances: readonly RuntimeImportInstance[], authProfile: ResolvedAuthProfile | null
): RuntimeHomeImport[] => methods.flatMap((method) => {
  const imported = authProfile?.imports[method];
  if (!imported) return [];
  const recipients = instances.filter((instance) => requestsRuntimeHomeImport(instance, method));
  if (recipients.length === 0) return [];
  if (imported.kind !== method || typeof imported.path !== "string" || !path.isAbsolute(imported.path) || /[:\u0000-\u001f\u007f]/u.test(imported.path)) {
    throw new SpawnfileError("validation_error", `Invalid source path for ${method} credential import`);
  }

  const unrelated = instances.filter((instance) => !recipients.includes(instance));
  const unconsenting = unrelated.find((instance) => !isBundledRuntimeAdapter(instance.runtime));
  if (unconsenting) {
    throw new SpawnfileError("validation_error",
      `Runtime ${unconsenting.runtime} does not request or support the ${method} import and shares this container. Use separate deployments with matching credential requirements or omit the import.`);
  }
  const otherHomes = unrelated.map(canonicalHome).filter((home): home is string => home !== null);
  const destinations = recipients.map((instance) => {
    const home = canonicalHome(instance);
    if (home === null) {
      throw new SpawnfileError("validation_error", `Runtime ${instance.id} requests the ${method} import without a home`);
    }
    if (otherHomes.some((peer) => overlaps(home, peer))) {
      throw new SpawnfileError("validation_error",
        `Runtime ${instance.id} shares a home with a runtime that does not request the ${method} import. Use separate homes or omit the import.`);
    }
    return path.posix.join(home, method === "codex" ? ".codex" : ".claude");
  });
  return [{ method, source: imported.path, targets: [...new Set(destinations)] }];
});

export const prepareRuntimeHomeImports = async (
  instances: readonly RuntimeImportInstance[], authProfile: ResolvedAuthProfile | null
): Promise<{ imports: RuntimeHomeImport[]; mountArgs: string[] }> => {
  const imports = resolveRuntimeHomeImports(instances, authProfile);
  const mountArgs: string[] = [];
  for (const { method, source, targets } of imports) {
    if (!(await fileExists(source))) {
      throw new SpawnfileError("validation_error", `Imported auth path for ${method} does not exist: ${source}`);
    }
    const credential = method === "claude-code"
      ? await loadImportedClaudeCodeCredential(source)
      : await loadImportedCodexCredential(source);
    if (!credential) {
      throw new SpawnfileError(
        "validation_error",
        `Imported ${method} auth at ${source} has no usable credential. Re-run the ${method} login (or re-import).`
      );
    }
    for (const target of targets) mountArgs.push("-v", `${source}:${target}`);
  }
  return { imports, mountArgs };
};
