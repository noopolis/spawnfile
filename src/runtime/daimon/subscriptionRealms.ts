import { daimonGatewayBootstrapMountPath, daimonGatewayedEngines, daimonGatewayRealmPath } from "./gateway.js";

/**
 * Realm resources for every gatewayed engine: one exclusive-reattach realm
 * volume the auth gateway alone owns, and one opaque bootstrap leaf mounted
 * under the gateway-private root. The volume id is the realm's identity, so a
 * moved mount path still reattaches the same login.
 */
export const daimonGatewayedSubscriptionRealms = (engines: readonly string[]) => {
  const descriptors = daimonGatewayedEngines(engines);
  return {
    opaqueMountTargets: descriptors.map((descriptor) => daimonGatewayBootstrapMountPath(descriptor.auth.realm)),
    persistentMounts: descriptors.map((descriptor) => ({
      id: `daimon-${descriptor.id}-subscription-realm`,
      lifecycle: "exclusive-reattach" as const,
      mountPath: daimonGatewayRealmPath(descriptor),
      reason: `Daimon host ${descriptor.id} subscription credential realm`
    }))
  };
};
