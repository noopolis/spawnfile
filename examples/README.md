# Example and Test Projects

Authored Spawnfile inputs live in two top-level directories:

- `examples/` — showcase org projects meant to be read as reference layouts.
- `fixtures/` — test-only org projects (and `fixtures/support/` executable
  test-support code).

They exercise portable compiler contracts and opt-in runtime integration paths;
product code must not contain fixture-specific behavior.

## Showcase Examples (`examples/`)

| Project | Contract |
|---|---|
| `single-agent` | Full agent workspace, docs, skills, MCP, secret, and OpenClaw lowering |
| `agent-with-subagents` | Canonical subagent graph resolution |
| `distribution-org` | Source-free image metadata, required/optional secrets, and managed Moltnet distribution |
| `moltnet-team-chat` | Nested-team representatives communicating through parent and child Moltnet rooms |
| `daimon-org` | One generated Daimon app with nested agents, shared files, and persistent Mneme recall |
| `mixed-runtime-org` | Daimon, OpenClaw, and PicoClaw sharing Moltnet and Mneme wiring |
| `jungian-daimon-org` | Nested council topology, representative routing, and scoped memory bindings |

## Test-Only Fixtures (`fixtures/`)

| Project | Contract |
|---|---|
| `multi-runtime-team` | Hierarchical team resolution and mixed runtime capability reporting |
| `docker-auth-agent` | Single-runtime Docker auth injection |
| `docker-auth-team` | Mixed OpenClaw/PicoClaw Docker auth injection |
| `operational-smoke` | Scheduled PicoClaw wake, workspace volume, Moltnet, and live status |
| `daimon-cli-memory-org` | Codex, Claude, Grok, and Agy CLI engines receiving schedule/dream memory context |
| `lifecycle-smoke` | Minimal single-agent scripted lifecycle (`up`/`artifacts export`/`down`) receipt smoke |
| `moltnet-memetics` | Live two-agent Moltnet conversation over real Codex/Grok |
| `office-sim` | Standalone scripted-engine harness proving the pi adapter's `scripted` engine kind |

Executable test-support helpers (cross-process fork fixtures and the trusted
Moltnet release stager) live under `fixtures/support/`.

Simulation worlds, transcripts, clocks, and domain-specific orchestration do not
belong in this suite. They should consume Spawnfile as an external system and
test their own behavior in their owning project.

Generated output such as `.spawn/`, runtime logs, credentials, and run
transcripts must remain untracked.
