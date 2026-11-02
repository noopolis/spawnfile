import type { ResolvedAuthProfile } from "../../auth/index.js";
import { daimonGatewayBootstrapMountPath, daimonGatewayedEngines, daimonGatewayRealmPath } from "./gateway.js";
import { DAIMON_ENGINES } from "./engines.js";

/**
 * Realm resources for every gatewayed engine: one exclusive-reattach realm
 * volume the auth gateway alone owns, and one opaque bootstrap leaf mounted
 * under the gateway-private root. The volume id is the realm's identity, so a
 * moved mount path still reattaches the same login.
 */
export const daimonSubscriptionRealmMountId = (engine: string): string => `daimon-${engine}-subscription-realm`;
const realmMountId = daimonSubscriptionRealmMountId;

/** The file inside a profile's unlock volume that is mounted as the realm unlock secret. */
export const DAIMON_PROFILE_UNLOCK_FILE = "unlock";

/**
 * The volume a compiled realm mount reattaches when the selected auth profile
 * holds that engine's login (`spawnfile auth login <engine>`): the profile's
 * realm volume instead of the deployment-lineage one.
 */
export const daimonProfileRealmVolume = (mountId: string, profile: Pick<ResolvedAuthProfile, "realms"> | null | undefined): string | undefined =>
  Object.entries(profile?.realms ?? {}).find(([engine]) => realmMountId(engine) === mountId)?.[1].realmVolume;

/** The read-only mount of a profile's unlock secret at the engine's declared unlock path. */
export const daimonProfileUnlockMountArgs = (unlockVolume: string, unlockMountPath: string): string[] => [
  "--mount", `type=volume,source=${unlockVolume},target=${unlockMountPath},volume-subpath=${DAIMON_PROFILE_UNLOCK_FILE},readonly`
];

/**
 * Whether a compiled persistent mount is a gatewayed realm. An organization
 * booted against an external gateway (`DAIMON_GATEWAY_URL` at boot) mounts
 * none of these and stages no bootstrap leaf: the gateway alone holds them.
 */
export const isDaimonGatewayRealmMountId = (id: string): boolean =>
  daimonGatewayedEngines(DAIMON_ENGINES).some((descriptor) => realmMountId(descriptor.id) === id);

export const daimonGatewayedSubscriptionRealms = (engines: readonly string[]) => {
  const descriptors = daimonGatewayedEngines(engines);
  return {
    opaqueMountTargets: descriptors.map((descriptor) => daimonGatewayBootstrapMountPath(descriptor.auth.realm)),
    persistentMounts: descriptors.map((descriptor) => ({
      id: realmMountId(descriptor.id),
      lifecycle: "exclusive-reattach" as const,
      mountPath: daimonGatewayRealmPath(descriptor),
      reason: `Daimon host ${descriptor.id} subscription credential realm`
    }))
  };
};
