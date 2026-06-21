# Pi Runtime Adapter

This folder lowers Spawnfile agents into a generated Pi SDK application.

- `adapter.ts` validates model support, emits per-agent workspace files, and merges Pi agents into one container target.
- `appTemplate.ts` renders generated Pi package/config artifacts.
- `appSource.ts` composes the generated runtime application source.
- `appPreludeSource.ts` renders generated imports and shared helper functions.
- `appActivitySource.ts` renders the bounded activity broker and activity HTTP/SSE endpoints.
- `appCoreSource.ts` renders the generated runtime application that starts Pi sessions, exposes the Moltnet wake control endpoint, and runs scheduled wakes.
- `runAuth.ts` adapts imported Codex auth into the Pi auth-store shape at run time.

Keep Pi-specific generation here. Generic container rendering belongs in `src/compiler/`.
