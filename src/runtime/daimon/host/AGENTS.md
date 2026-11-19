# Daimon host integration

This directory owns the native container entrypoint, worker provisioning, gateway,
broker, ownership checks and image-consumption rules for the Daimon adapter.

- Keep the same ownership and credential checks for compiled and prebuilt images.
- Validate pinned image manifests, receipts and per-worker limits before launch.
- Keep runtime-specific shell fragments and their tests alongside the code that renders them.
- Use Spawnfile's host contracts for shared deployment and lifecycle decisions.

`integration.ts` exports the selected host capability. `entrypoint.ts` pairs
wrapper metadata with the implementation and `stateOwnership.ts` prepares
private state paths. `targetDetails.ts` carries in-memory worker configuration
from native lowering to provisioning. `imageDocker.ts` verifies the prebuilt
receipt and binds `imageAuth.ts` to the verified engine descriptors.
