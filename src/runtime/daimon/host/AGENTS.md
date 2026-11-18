# Daimon host integration

This directory owns the native container entrypoint, worker provisioning, gateway,
broker, ownership checks and image-consumption rules for the Daimon adapter.

- Keep the same ownership and credential checks for compiled and prebuilt images.
- Validate pinned image manifests, receipts and per-worker limits before launch.
- Keep runtime-specific shell fragments and their tests alongside the code that renders them.
- Use Spawnfile's host contracts for shared deployment and lifecycle decisions.
