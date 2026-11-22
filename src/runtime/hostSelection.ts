import { SpawnfileError } from "../shared/errors.js";
import { getRuntimeAdapter, hasRuntimeAdapter } from "./registry.js";
import type { RuntimeHostIntegration, RuntimeHostSecret } from "./hostTypes.js";

export const runtimeHost = (name: string): RuntimeHostIntegration | undefined =>
  hasRuntimeAdapter(name) ? getRuntimeAdapter(name).host : undefined;

export const adapterManagedAuthMethods = (name: string) =>
  hasRuntimeAdapter(name) ? getRuntimeAdapter(name).container.adapterManagedAuthMethods : undefined;

export const selectedRuntimeHosts = (names: Iterable<string>) =>
  [...new Set(names)].flatMap((name) => {
    const host = runtimeHost(name);
    return host ? [{ name, host }] : [];
  });

export const selectRuntimeEntrypoint = (names: Iterable<string>) => {
  const entries = selectedRuntimeHosts(names).flatMap(({ name, host }) =>
    host.entrypoint ? [{ name, entrypoint: host.entrypoint }] : []);
  if (entries.length > 1) {
    throw new SpawnfileError("compile_error", `Conflicting runtime entrypoint wrappers: ${entries.map(({ name }) => name).join(", ")}`);
  }
  const selected = entries[0];
  if (selected) {
    const { accountUid, path } = selected.entrypoint;
    if (!Number.isInteger(accountUid) || accountUid < 1 || accountUid > 2147483647
      || !/^\/[A-Za-z0-9._/-]+$/u.test(path) || path.split("/").includes("..")) {
      throw new SpawnfileError("compile_error", `Invalid entrypoint wrapper for runtime ${selected.name}`);
    }
  }
  return selected;
};

export const selectRuntimeGeneratedSecrets = (names: Iterable<string>): ReadonlyMap<string, RuntimeHostSecret> =>
  new Map(selectedRuntimeHosts(names).flatMap(({ host }) => Object.entries(host.generatedSecrets ?? {})));
