import { getDaimonEngineDescriptor } from "./engines.js";

export const daimonPortableSubscriptionRealms = (engines: readonly string[]) => {
  const realms = [...new Set(engines)].sort().flatMap((engine) => {
    const descriptor = getDaimonEngineDescriptor(engine);
    return descriptor?.auth.staging === "portable-realm"
      ? [{ engine, realm: descriptor.auth.realm }]
      : [];
  });
  return {
    opaqueMountTargets: realms.map(({ realm }) => realm.bootstrapMountPath),
    persistentMounts: realms.map(({ engine, realm }) => ({
      id: `daimon-${engine}-subscription-realm`,
      lifecycle: "exclusive-reattach" as const,
      mountPath: realm.durableMountPath,
      reason: `Daimon host ${engine} subscription credential realm`
    }))
  };
};
