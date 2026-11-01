import { getDaimonEngineDescriptor } from "./engines.js";
import { daimonGatewayBootstrapMountPath, isDaimonGatewayedEngine } from "./gateway.js";

export const daimonPortableSubscriptionRealms = (engines: readonly string[]) => {
  const realms = [...new Set(engines)].sort().flatMap((engine) => {
    const descriptor = getDaimonEngineDescriptor(engine);
    return isDaimonGatewayedEngine(descriptor)
      ? [{ engine, realm: descriptor.auth.realm, bootstrapMountPath: daimonGatewayBootstrapMountPath(descriptor.auth.realm) }]
      : [];
  });
  return {
    // The gateway alone owns a portable realm; its bootstrap leaf is mounted under the gateway-private root.
    opaqueMountTargets: realms.map(({ bootstrapMountPath }) => bootstrapMountPath),
    persistentMounts: realms.map(({ engine, realm }) => ({
      id: `daimon-${engine}-subscription-realm`,
      lifecycle: "exclusive-reattach" as const,
      mountPath: realm.durableMountPath,
      reason: `Daimon host ${engine} subscription credential realm`
    }))
  };
};
