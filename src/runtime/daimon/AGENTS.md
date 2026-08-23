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

The consumed Daimon manifest may declare the AGY host realm's stable volume
target and opaque unlock slot. This adapter renders those resources but never
starts D-Bus, runs AGY, or reads either secret.
