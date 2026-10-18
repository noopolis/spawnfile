# Concurrent trial admission

Owns runtime-neutral slot descriptor loading and exclusive leases. The provisioner
owns paths, identities, port allocation and isolation. Preparation consumes the
leased descriptor; this module never generates runtime paths or changes permissions.
Export through index.ts. Test overlap, blocked admission, cancellation, quarantine,
and invalid declarations without native runtimes or model calls.

`spawnfile.training-slots.v1` retains nonempty opaque roots and distinct worker
uids. v2 requires `isolation: 'shared-uid'` on each descriptor, permits a shared
container uid and empty roots, and still requires disjoint indices/port blocks.
Empty roots mean preparation owns fresh per-trial paths, not provisioned paths.
Do not infer UID isolation or broker authority from a native lease.
