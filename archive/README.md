# Archive

Historical material retained for context, not current instructions or executable
tooling. File contents describe the repository at the time they were written.

| Material | Why archived | Current reference |
| --- | --- | --- |
| [Daimon migration plan](DAIMON_RUNTIME_MIGRATION_PLAN.md) | Plan for replacing the former Pi alias; predates the standalone adapter | [Daimon adapter](../src/runtime/daimon/AGENTS.md), [runtime contracts](../specs/RUNTIMES.md) |
| [Distribution design](DISTRIBUTION.md) | Original phased design, superseded as implementation authority | [Distribution specification](../specs/DISTRIBUTION.md) |
| [Diagrams and boundary audit](diagrams/) | Point-in-time illustrations and migration blockers; not maintained against current code | [Compiler specification](../specs/COMPILER.md), [ecosystem boundaries](../specs/ECOSYSTEM_RUNTIME_BOUNDARIES.md) |
| [Legacy worktree tools](legacy-worktree-tools/) | Assume sibling projects live inside `ecosystem/`; that layout no longer exists here. No package command or CI job uses them | [Contributing](../CONTRIBUTING.md), [maintained scripts](../scripts/README.md) |

Archived JavaScript is preserved as historical source. It is excluded from the
maintained TypeScript scripts, package contents, and automated test discovery.
Do not run archived tools or copy their configuration into a current deployment.
