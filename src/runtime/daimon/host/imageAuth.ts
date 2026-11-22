import path from "node:path";

import type { ResolvedAuthProfile } from "../../../auth/index.js";
import type { DistributionRuntimeInstance } from "../../../distribution/types.js";
import { SpawnfileError } from "../../../shared/errors.js";
import type { RuntimeImageAuthPreparer } from "../../hostTypes.js";
import { daimonGatewayBootstrapMountPath } from "../gateway.js";
import { DAIMON_ENGINE_DESCRIPTORS } from "../engines.js";
import type { DaimonEngineDescriptors } from "../engineDescriptorSchema.js";
import {
  assertDaimonCredentialContainerOwner, assertSafeDaimonSourceFile, DAIMON_CREDENTIAL_CONTAINER_UID,
  daimonSourceEnvironmentName, daimonSourcePathForEngine
} from "../runAuth.js";

const daimonNodeSlug = (nodeId: string): string =>
  nodeId.replace(/^agent:/u, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

const daimonInstanceRoot = (
  instance: DistributionRuntimeInstance
): string => {
  const root = path.posix.join("/var/lib/spawnfile/instances/daimon", instance.id);
  if (instance.home_path !== null || instance.config_path !== path.posix.join(root, "daimon/daimon-organization-runtime.json")
    || instance.workspace_path !== path.posix.join(root, "workspace")) {
    throw new SpawnfileError("validation_error", "Daimon image runtime paths are not canonical");
  }
  return root;
};

export const prepareDaimonImageAuthMounts = async (
  instance: DistributionRuntimeInstance,
  environment: Record<string, string | undefined>,
  authProfile: ResolvedAuthProfile | null,
  containerCredentialUid: number = DAIMON_CREDENTIAL_CONTAINER_UID,
  inventory: DaimonEngineDescriptors = DAIMON_ENGINE_DESCRIPTORS
): Promise<string[]> => {
  const engines = Object.entries(instance.engine_by_node_id ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (engines.length === 0) {
    throw new SpawnfileError("validation_error", "Daimon image report is missing its engine map");
  }
  const engineNodeIds = engines.map(([nodeId]) => nodeId);
  if (JSON.stringify(engineNodeIds) !== JSON.stringify([...instance.node_ids].sort())) {
    throw new SpawnfileError("validation_error", "Daimon image engine map does not match its declared agents");
  }
  if (engines.some(([, engine]) => !Object.hasOwn(inventory, engine))) {
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
    .map((engine) => inventory[engine]!);
  // Keep portable leaves, broker bootstrap, then realm unlock mounts in the
  // existing order while resolving every engine's staging contract from data.
  for (const descriptor of descriptors) {
    if (descriptor.auth.staging !== "portable-file") continue;
    const source = daimonSourcePathForEngine(descriptor.id, environment, authProfile, descriptor);
    const ownerUid = await assertSafeDaimonSourceFile(source, descriptor.id, descriptor.auth.maxCredentialBytes, descriptor);
    assertDaimonCredentialContainerOwner(ownerUid, descriptor.id, containerCredentialUid);
    for (const [nodeId, engine] of engines) {
      if (engine !== descriptor.id) continue;
      const target = path.posix.join(root, "runtime-homes", daimonNodeSlug(nodeId), descriptor.credentialMaterial!.sourceRelativePath!);
      mounts.push("-v", `${source}:${target}:ro`);
    }
  }
  for (const descriptor of descriptors) {
    if (descriptor.auth.staging !== "portable-realm") continue;
    const source = daimonSourcePathForEngine(descriptor.id, environment, authProfile, descriptor);
    const ownerUid = await assertSafeDaimonSourceFile(source, descriptor.id, descriptor.auth.maxCredentialBytes, descriptor);
    assertDaimonCredentialContainerOwner(ownerUid, descriptor.id, containerCredentialUid);
    mounts.push("-v", `${source}:${daimonGatewayBootstrapMountPath(descriptor.auth.realm)}:ro`);
  }
  for (const descriptor of descriptors) {
    if (descriptor.auth.staging !== "broker-realm") continue;
    // Broker bootstrap leaves are read and staged by root, so they deliberately
    // do not require ownership by the eventual organization uid.
    const source = daimonSourcePathForEngine(descriptor.id, environment, null, descriptor);
    await assertSafeDaimonSourceFile(source, descriptor.id, descriptor.auth.maxCredentialBytes, descriptor);
    mounts.push("-v", `${source}:${daimonGatewayBootstrapMountPath(descriptor.auth.realm)}:ro`);
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

export const createDaimonImageAuthPreparer = (
  inventory?: DaimonEngineDescriptors
): RuntimeImageAuthPreparer => (instance, input) => prepareDaimonImageAuthMounts(
  instance, input.sourceEnvironment, input.authProfile, input.containerCredentialUid, inventory
);
