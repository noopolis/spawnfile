import path from "node:path";

import { getDaimonEngineDescriptor, type DaimonEngineDescriptor } from "./engines.js";

/**
 * In-container placement of Daimon's auth gateway (`daimon-runtime gateway`).
 *
 * The gateway is the only process that holds a gatewayed engine's subscription
 * login. It runs as its own uid on loopback; the organization runtime gets a
 * URL and a key instead of a realm. These names are Daimon's public contract
 * (`src/gateway/` and `engines/codex/gatewayProvider.ts` in Daimon).
 */
export const DAIMON_GATEWAY_URL_ENV = "DAIMON_GATEWAY_URL";
/** Must keep its `_KEY` suffix: Codex's shell policy keeps `*KEY*` out of model-run commands. */
export const DAIMON_GATEWAY_KEY_ENV = "DAIMON_GATEWAY_KEY";
export const DAIMON_GATEWAY_CONFIG_VERSION = "noopolis.daimon.gateway.v1";
export const DAIMON_GATEWAY_KEY_TABLE_VERSION = "noopolis.daimon.gateway-keys.v1";
export const DAIMON_GATEWAY_HOST = "127.0.0.1";
export const DAIMON_GATEWAY_PORT = 43_200;
export const DAIMON_GATEWAY_URL = `http://${DAIMON_GATEWAY_HOST}:${DAIMON_GATEWAY_PORT}`;
/** Root-owned, gateway-group-readable: config and key table. */
export const DAIMON_GATEWAY_ETC = "/etc/daimon-gateway";
export const DAIMON_GATEWAY_CONFIG = `${DAIMON_GATEWAY_ETC}/config.json`;
export const DAIMON_GATEWAY_KEY_TABLE = `${DAIMON_GATEWAY_ETC}/keys.json`;
/** Gateway-private copies of bootstrap leaves, rewritten on every start. */
export const DAIMON_GATEWAY_RUN = "/run/daimon-gateway";
/**
 * Bind target directory for gatewayed bootstrap leaves. The host leaf keeps its
 * host owner (the organization uid), so it is mounted under a root-only 0700
 * directory the organization uid cannot traverse; root copies it for the gateway.
 */
export const DAIMON_GATEWAY_BOOTSTRAP_ROOT = "/var/lib/spawnfile/daimon/gateway-bootstrap";
/** Key-table principal: Daimon reads one gateway key per organization runtime process. */
export const DAIMON_GATEWAY_PRINCIPAL = "daimon-organization";

/** Staging kinds whose login is one durable realm seeded from a bootstrap leaf: exactly what the gateway owns. */
const GATEWAYED_STAGINGS = new Set<DaimonEngineDescriptor["auth"]["staging"]>(["portable-realm", "broker-realm"]);

export type DaimonGatewayedDescriptor = DaimonEngineDescriptor & {
  auth: Extract<DaimonEngineDescriptor["auth"], { staging: "portable-realm" | "broker-realm" }>;
};

/**
 * Whether Spawnfile places a gateway for this engine. The descriptors carry
 * no gateway field, so the seam is the staging role: every realm-staged login
 * (portable or brokered) is gatewayed; per-agent files and AGY's secret
 * service never are. Replace with Daimon's own declaration once published.
 */
export const isDaimonGatewayedEngine = (descriptor: DaimonEngineDescriptor | undefined): descriptor is DaimonGatewayedDescriptor =>
  descriptor !== undefined && GATEWAYED_STAGINGS.has(descriptor.auth.staging);

export const daimonGatewayedEngines = (engines: Iterable<string>): DaimonGatewayedDescriptor[] =>
  [...new Set(engines)].sort().flatMap((engine) => {
    const descriptor = getDaimonEngineDescriptor(engine);
    return isDaimonGatewayedEngine(descriptor) ? [descriptor] : [];
  });

type RealmBootstrap = Readonly<{ bootstrapMountPath: string }>;

/** Where a gatewayed engine's read-only bootstrap leaf is bind-mounted. */
export const daimonGatewayBootstrapMountPath = (realm: RealmBootstrap): string =>
  path.posix.join(DAIMON_GATEWAY_BOOTSTRAP_ROOT, path.posix.basename(realm.bootstrapMountPath));

/** The gateway-owned copy the gateway reads as its bootstrap. */
export const daimonGatewayBootstrapCopyPath = (realm: RealmBootstrap): string =>
  path.posix.join(DAIMON_GATEWAY_RUN, path.posix.basename(realm.bootstrapMountPath));

/**
 * Where the gateway mounts a realm volume. A brokered engine's descriptor
 * realm path is also its broker's local turn-state home, so its volume moves
 * to a sibling `gateway-` path; every other realm keeps its descriptor path.
 */
export const daimonGatewayRealmPath = (descriptor: DaimonGatewayedDescriptor): string => {
  const durable = descriptor.auth.realm.durableMountPath;
  return descriptor.broker?.credentialHomePath === durable
    ? path.posix.join(path.posix.dirname(durable), `gateway-${path.posix.basename(durable)}`)
    : durable;
};

/** Gateway-private refresh home for a brokered engine, whose CLI refreshes its own login. */
export const daimonGatewayRefreshScratchPath = (descriptor: DaimonGatewayedDescriptor): string | undefined =>
  descriptor.broker === null ? undefined : path.posix.join(DAIMON_GATEWAY_RUN, `${descriptor.id}-refresh`);

export const renderDaimonGatewayConfig = (descriptors: readonly DaimonGatewayedDescriptor[]): string =>
  `${JSON.stringify({
    version: DAIMON_GATEWAY_CONFIG_VERSION,
    host: DAIMON_GATEWAY_HOST,
    port: DAIMON_GATEWAY_PORT,
    key_table_path: DAIMON_GATEWAY_KEY_TABLE,
    ...Object.fromEntries(descriptors.map((descriptor) => [descriptor.id, {
      realm_path: daimonGatewayRealmPath(descriptor),
      bootstrap_path: daimonGatewayBootstrapCopyPath(descriptor.auth.realm),
      ...(descriptor.broker === null ? {} : {
        command: descriptor.broker.grokExecutablePath,
        scratch_path: daimonGatewayRefreshScratchPath(descriptor)
      })
    }]))
  })}\n`;
