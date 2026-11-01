import { daimonGatewayBootstrapMountPath, daimonGatewayedEngines, daimonGatewayRealmPath } from "./gateway.js";
import { DAIMON_ENGINES } from "./engines.js";

/**
 * Realm resources for every gatewayed engine: one exclusive-reattach realm
 * volume the auth gateway alone owns, and one opaque bootstrap leaf mounted
 * under the gateway-private root. The volume id is the realm's identity, so a
 * moved mount path still reattaches the same login.
 */
const realmMountId = (engine: string): string => `daimon-${engine}-subscription-realm`;

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
