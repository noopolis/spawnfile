# Concurrent trial admission

Owns runtime-neutral slot descriptor loading and exclusive leases. The provisioner
owns paths, identities, port allocation and isolation. Preparation consumes the
leased descriptor; this module never generates runtime paths or changes permissions.
Export through index.ts. Test overlap, blocked admission, cancellation, quarantine,
and invalid declarations without native runtimes or model calls.
