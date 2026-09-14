# Training Container Launcher

- One immutable image runs the whole experiment; the host only prepares declared mounts and supervises Docker.
- `contract.ts` validates explicit launch configuration. `prepare.ts` maps canonical context and CLI paths into declared mounts.
- `process.ts` owns bounded Docker subprocess transport. `launch.ts` owns exact container identity, streaming, receipt verification and cleanup.
- Never mount a Docker socket, host home, arbitrary environment, or host executable. Auth bindings are explicit read-only leaf files.
- Dry-run stays in the existing host estimator. Actual training must never fall back to host execution.
- Docker bind mounts currently require an explicitly selected local Unix-socket context. Remote daemon staging is unsupported.
- Keep files under 400 lines; adjacent negative tests must prove ownership, cancellation and final receipt checks.
