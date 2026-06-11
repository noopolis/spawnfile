# Deployment Guide

This folder owns deployment records and deployment-manager helpers.

## Structure

```text
src/deployment/
├── index.ts         # Barrel exports
├── names.ts         # Deployment name validation and record path helpers
├── target.ts        # Docker target endpoint fingerprint helpers
├── dockerLabels.ts  # Docker label construction for managed units
├── dockerInspect.ts # Bounded Docker container inspection for status --live
├── dockerLogs.ts    # Bounded Docker log collection with redaction for status --logs
├── dockerProbeGateway.ts # Manager-mediated exec/HTTP gateway for runtime status probes
├── record.ts        # Deployment record schema, parser, reader, and writer
└── dockerManager.ts # Docker deployment record assembly
```

## Rules

- Keep deployment records free of secrets. Paths are allowed only for local operator metadata.
- Docker labels must contain identifiers only, never local paths or secret-bearing values.
- Records are written only after a detached deployment has successfully started.
- Keep manager-specific logic here; CLI handlers should only pass user options through.
- Live inspection helpers should normalize Docker failures into status summaries instead of throwing for missing containers.
