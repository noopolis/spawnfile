# Inference Provider Registry

Owns the neutral built-in provider descriptors and their configuration validation.
Runtime composition extends the registry with engine-owned descriptors. Schema,
identity defaults and dispatch consume that supplied registry; never branch on a
provider ID in the training core. Factories run only after configuration preflight.

`policy.ts` projects registered policy versions into immutable route/checkpoint
identities. Keep this executable default-provider composition outside contracts.
