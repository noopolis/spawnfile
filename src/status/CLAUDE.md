# Status Folder

This folder owns the read-only `spawnfile status` status model, selectors, compile-report loading, and rendering.

## Structure

```text
src/status/
├── buildStatus.ts      # Builds static status observations from OrganizationView and compile report data
├── compiledContainerObservations.ts # Compile-report container/runtime/network artifact observations
├── compileReport.ts    # Defensive compile report loader for old and new report shapes
├── deploymentLogs.ts   # Redacted Docker log tail observations for status --live --logs
├── deployments.ts      # Deployment record summaries and optional live unit inspection
├── index.ts            # Barrel exports
├── moltnetProbes.ts    # Metadata-only Moltnet live network probes
├── renderStatus.ts     # Pretty, quiet, and JSON status renderers
├── selectionSubjects.ts # Expands selectors to related runtime, room, member, and deployment subjects
├── runtimeProbes.ts    # Adapter-owned runtime probe collection for status --live
├── selectors.ts        # Agent/team/network/runtime selector resolution
├── traversal.ts        # OrganizationView traversal helpers
└── types.ts            # Status model and command-result types
```

## Rules

- Keep status static/offline by default.
- Live inspection must be opt-in, bounded, and mediated through deployment helpers.
- Logs must stay opt-in and redacted. Status never exposes a raw-log mode.
- Do not call generated runtime CLIs here. Runtime health must go through adapter-owned probes and deployment-manager gateways.
- Treat `OrganizationView` as the graph projection source of truth; do not rebuild a parallel source graph from manifests.
- Compile reports are optional. A missing report is `unknown`, while malformed or unreadable reports are input failures.
