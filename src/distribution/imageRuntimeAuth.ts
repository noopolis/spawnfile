import { getDaimonEngineDescriptor } from "../runtime/daimon/index.js";
import path from "node:path";

import type { ResolvedAuthProfile } from "../auth/index.js";
import {
  loadImportedClaudeCodeCredential,
  loadImportedCodexCredential
} from "../auth/index.js";
import { fileExists } from "../filesystem/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import {
  assertDaimonCredentialContainerOwner,
  assertSafeDaimonSourceFile,
  DAIMON_CREDENTIAL_CONTAINER_UID,
  daimonSourceEnvironmentName,
  daimonSourcePathForEngine
} from "../runtime/daimon/runAuth.js";
import { SpawnfileError } from "../shared/index.js";

import type { DistributionReport } from "./types.js";

export interface ImageRuntimeAuthInput {
  authProfile: ResolvedAuthProfile | null;
  /**
   * The uid the deployed Daimon image reads its credential leaves as. Defaults
   * to the compiled image's organization uid; only override it against an image
   * known to run under a different identity.
   */
  daimonContainerCredentialUid?: number;
  report: DistributionReport;
  sourceEnvironment?: Record<string, string | undefined>;
  tempRoot: string;
}

export interface ImageRuntimeAuthResult {
  coveredModelSecrets: Set<string>;
  mountArgs: string[];
}

const importMountTargetName = (kind: "claude-code" | "codex"): string =>
  kind === "claude-code" ? ".claude" : ".codex";

const daimonNodeSlug = (nodeId: string): string =>
  nodeId.replace(/^agent:/u, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

const daimonInstanceRoot = (
  instance: DistributionReport["runtime_instances"][number]
): string => {
  const root = path.posix.join("/var/lib/spawnfile/instances/daimon", instance.id);
  if (instance.home_path !== null || instance.config_path !== path.posix.join(root, "daimon/daimon-organization-runtime.json")
    || instance.workspace_path !== path.posix.join(root, "workspace")) {
    throw new SpawnfileError("validation_error", "Daimon image runtime paths are not canonical");
  }
  return root;
};

export const prepareDaimonImageAuthMounts = async (
  instance: DistributionReport["runtime_instances"][number],
  environment: Record<string, string | undefined>,
  authProfile: ResolvedAuthProfile | null,
  containerCredentialUid: number = DAIMON_CREDENTIAL_CONTAINER_UID
): Promise<string[]> => {
  const engines = Object.entries(instance.engine_by_node_id ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (engines.length === 0) {
    throw new SpawnfileError("validation_error", "Daimon image report is missing its engine map");
  }
  const engineNodeIds = engines.map(([nodeId]) => nodeId);
  if (JSON.stringify(engineNodeIds) !== JSON.stringify([...instance.node_ids].sort())) {
    throw new SpawnfileError("validation_error", "Daimon image engine map does not match its declared agents");
  }
  if (engines.some(([, engine]) => !getDaimonEngineDescriptor(engine))) {
    throw new SpawnfileError("validation_error", "Daimon image report declares an unsupported engine");
  }
  const root = daimonInstanceRoot(instance);
  const mounts: string[] = [];
  const slugs = new Map<string, string>();
  for (const [nodeId] of engines) {
    const slug = daimonNodeSlug(nodeId);
    if (!slug || slugs.has(slug)) throw new SpawnfileError("validation_error", "Daimon image report has an unsafe agent id");
    slugs.set(slug, nodeId);
  }
  const descriptors = [...new Set(engines.map(([, engine]) => engine))]
    .map((engine) => getDaimonEngineDescriptor(engine)!);
  // Keep portable leaves, broker bootstrap, then realm unlock mounts in the
  // existing order while resolving every engine's staging contract from data.
  for (const descriptor of descriptors) {
    if (descriptor.auth.staging !== "portable-file") continue;
    const source = daimonSourcePathForEngine(descriptor.id, environment, authProfile);
    const ownerUid = await assertSafeDaimonSourceFile(source, descriptor.id, descriptor.auth.maxCredentialBytes, descriptor.id);
    assertDaimonCredentialContainerOwner(ownerUid, descriptor.id, containerCredentialUid);
    for (const [nodeId, engine] of engines) {
      if (engine !== descriptor.id) continue;
      const target = path.posix.join(root, "runtime-homes", daimonNodeSlug(nodeId), descriptor.credentialMaterial!.sourceRelativePath!);
      mounts.push("-v", `${source}:${target}:ro`);
    }
  }
  for (const descriptor of descriptors) {
    if (descriptor.auth.staging !== "portable-realm") continue;
    const source = daimonSourcePathForEngine(descriptor.id, environment, authProfile);
    const ownerUid = await assertSafeDaimonSourceFile(source, descriptor.id, descriptor.auth.maxCredentialBytes, descriptor.id);
    assertDaimonCredentialContainerOwner(ownerUid, descriptor.id, containerCredentialUid);
    mounts.push("-v", `${source}:${descriptor.auth.realm.bootstrapMountPath}:ro`);
  }
  for (const descriptor of descriptors) {
    if (descriptor.auth.staging !== "broker-realm") continue;
    // Broker bootstrap leaves are read and staged by root, so they deliberately
    // do not require ownership by the eventual organization uid.
    const source = daimonSourcePathForEngine(descriptor.id, environment);
    await assertSafeDaimonSourceFile(source, descriptor.id, descriptor.auth.maxCredentialBytes, descriptor.id);
    mounts.push("-v", `${source}:${descriptor.auth.realm.bootstrapMountPath}:ro`);
  }
  for (const descriptor of descriptors) {
    if (descriptor.auth.staging !== "secret-service") continue;
    const realm = descriptor.auth.realm;
    const source = environment[daimonSourceEnvironmentName(realm.unlockSourceSlot)]?.trim();
    if (!source) throw new SpawnfileError("validation_error", "Daimon runtime auth is missing the operator-authorized AGY realm unlock artifact");
    const ownerUid = await assertSafeDaimonSourceFile(source, "AGY realm unlock", realm.maxUnlockBytes);
    assertDaimonCredentialContainerOwner(ownerUid, "AGY realm unlock", containerCredentialUid);
    mounts.push("-v", `${source}:${realm.unlockMountPath}:ro`);
  }
  return mounts;
};

/**
 * Builds the credential mounts for a sourceless image deployment that uses
 * import-based model auth. The OAuth-mode config is already baked into the
 * image, so this only mounts the consumer's credential tokens (per-adapter) and
 * their raw import directories into each runtime home — the same material a
 * project deployment provides, without needing the project source.
 */
export const prepareImageRuntimeAuthMounts = async (
  input: ImageRuntimeAuthInput
): Promise<ImageRuntimeAuthResult> => {
  const coveredModelSecrets = new Set<string>();
  const mountArgs: string[] = [];
  const runtimeHomes = new Set<string>();

  for (const instance of input.report.runtime_instances) {
    if (instance.runtime === "daimon") {
      mountArgs.push(...await prepareDaimonImageAuthMounts(
        instance,
        input.sourceEnvironment ?? process.env,
        input.authProfile,
        input.daimonContainerCredentialUid ?? DAIMON_CREDENTIAL_CONTAINER_UID
      ));
      continue;
    }
    if (instance.home_path) runtimeHomes.add(instance.home_path);
    if (!input.authProfile) continue;
    const adapter = getRuntimeAdapter(instance.runtime);
    if (!adapter.prepareRuntimeAuth) {
      continue;
    }
    const prepared = await adapter.prepareRuntimeAuth({
      authProfile: input.authProfile,
      env: {},
      instance: {
        config_path: instance.config_path,
        home_path: instance.home_path,
        id: instance.id,
        model_auth_methods: instance.model_auth_methods,
        model_secrets_required: instance.model_secrets_required,
        runtime: instance.runtime
      },
      outputDirectory: "",
      tempRoot: input.tempRoot
    });
    for (const secret of prepared.coveredModelSecrets) {
      coveredModelSecrets.add(secret);
    }
    mountArgs.push(...prepared.mountArgs);
  }

  // Mount the raw credential import directories into each runtime home so the
  // runtime's OAuth client can read them (e.g. ~/.claude, ~/.codex).
  for (const kind of ["claude-code", "codex"] as const) {
    const entry = input.authProfile?.imports[kind];
    if (!entry) {
      continue;
    }
    if (!(await fileExists(entry.path))) {
      throw new SpawnfileError(
        "validation_error",
        `Imported auth path for ${kind} does not exist: ${entry.path}`
      );
    }
    // The directory existing is not enough: a registered import whose credential
    // file is missing, expired, or malformed would mount cleanly but produce a
    // container that cannot authenticate. Load it now so the failure surfaces
    // before the container starts, mirroring the project-deployment path.
    const credential =
      kind === "claude-code"
        ? await loadImportedClaudeCodeCredential(entry.path)
        : await loadImportedCodexCredential(entry.path);
    if (!credential) {
      throw new SpawnfileError(
        "validation_error",
        `Imported ${kind} auth at ${entry.path} has no usable credential. ` +
          `Re-run the ${kind} login (or re-import) before deploying this image.`
      );
    }
    for (const home of runtimeHomes) {
      mountArgs.push("-v", `${entry.path}:${path.posix.join(home, importMountTargetName(kind))}`);
    }
  }

  return { coveredModelSecrets, mountArgs };
};
