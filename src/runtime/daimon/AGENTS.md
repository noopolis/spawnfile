# Daimon Runtime Adapter

This folder lowers a resolved Spawnfile organization into the public
`noopolis.daimon.organization-runtime.v1` contract. It owns no model CLI
argv, credential copying, MCP process, scheduler, or Moltnet
bridge code. Daimon owns one wake at a time after this adapter has prepared
the organization artifact.

Keep the generated configuration strict and source-free. The adapter emits
one organization host target (at most 32 agents), not one generated engine
application per agent. It permits only compiler-owned Moltnet public-wake
attachments; Daimon consumes a generic 0700 private ingress itself. `runtime:
pi` remains the legacy generated Pi path.

The consumed Daimon manifest declares stable AGY and Grok host-realm volumes
plus their opaque bootstrap slots. This adapter renders those resources but
never starts a provider CLI, D-Bus, or a turn.

The consumed manifest also pins the native Grok broker source/x64/arm64
digests, fixed root/org/broker/worker identities, root-only registrations,
and loopback-only provider/MCP endpoints. Container provisioning must match
that authority exactly and must not publish either broker port.

Codex keeps an isolated per-agent credential home. Grok keeps isolated
per-agent non-auth state but one durable rotating subscription credential
realm; never fan out Grok refresh authority across writable homes.
