/**
 * The fixed container-side uids a compiled Daimon image runs under.
 *
 * These are compiler-wide constants, not per-organization values: the rendered
 * Daimon entrypoint pins `uid=DAIMON_ORGANIZATION_UID` and drops to it through
 * `setpriv --reuid`, so every organization's Daimon runtime process shares the
 * same uid. The engine broker and its Grok workers run under their own fixed
 * uids alongside it.
 *
 * Why the deploy path cares: Daimon's own credential guards compare a
 * credential file's owner against `process.getuid()` *inside* the container
 * (`portableCredentialMaterial.ts` for Codex, `agySubscriptionRealm.ts` for the
 * AGY unlock secret). Spawnfile bind-mounts those files read-only from the
 * host, the daemon applies no user-namespace remapping, and the credential
 * leaves are declared opaque so the entrypoint ownership guard never chowns
 * them. A host file therefore keeps its host uid inside the container, which
 * makes "owned by DAIMON_ORGANIZATION_UID" a host-side deployment requirement
 * rather than something the container can repair.
 */
export const DAIMON_ORGANIZATION_UID = 2_000;
export const DAIMON_BROKER_UID = 2_100;
export const DAIMON_FIRST_WORKER_UID = 2_200;
