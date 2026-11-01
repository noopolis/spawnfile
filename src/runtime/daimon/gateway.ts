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

/**
 * Whether Spawnfile places a gateway for this engine. The pinned descriptors
 * carry no gateway field yet, so the seam is the staging role: a portable
 * realm is exactly what the gateway owns. Replace with the descriptor's own
 * gateway declaration once Daimon publishes one.
 */
export type DaimonGatewayedDescriptor = DaimonEngineDescriptor & { auth: Extract<DaimonEngineDescriptor["auth"], { staging: "portable-realm" }> };

export const isDaimonGatewayedEngine = (descriptor: DaimonEngineDescriptor | undefined): descriptor is DaimonGatewayedDescriptor =>
  descriptor?.auth.staging === "portable-realm";

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

export const renderDaimonGatewayConfig = (descriptors: readonly DaimonGatewayedDescriptor[]): string =>
  `${JSON.stringify({
    version: DAIMON_GATEWAY_CONFIG_VERSION,
    host: DAIMON_GATEWAY_HOST,
    port: DAIMON_GATEWAY_PORT,
    key_table_path: DAIMON_GATEWAY_KEY_TABLE,
    ...Object.fromEntries(descriptors.map((descriptor) => [descriptor.id, {
      realm_path: descriptor.auth.realm.durableMountPath,
      bootstrap_path: daimonGatewayBootstrapCopyPath(descriptor.auth.realm)
    }]))
  })}\n`;
