# Test Projects

The projects under `test/fixtures/` are authored Spawnfile inputs. They exercise
portable compiler contracts and opt-in runtime integration paths; product code
must not contain fixture-specific behavior.

## Compiler Fixtures

| Project | Contract |
|---|---|
| `single-agent` | Full agent workspace, docs, skills, MCP, secret, and OpenClaw lowering |
| `multi-runtime-team` | Hierarchical team resolution and mixed runtime capability reporting |
| `agent-with-subagents` | Canonical subagent graph resolution |
| `distribution-org` | Source-free image metadata, required/optional secrets, and managed Moltnet distribution |

## Runtime E2E Fixtures

| Project | Contract |
|---|---|
| `e2e/docker-auth-agent` | Single-runtime Docker auth injection |
| `e2e/docker-auth-team` | Mixed OpenClaw/PicoClaw Docker auth injection |
| `e2e/operational-smoke` | Scheduled PicoClaw wake, workspace volume, Moltnet, and live status |
| `e2e/moltnet-team-chat` | Nested-team representatives communicating through parent and child Moltnet rooms |
| `e2e/daimon-org` | One generated Daimon app with nested agents, shared files, and persistent Mneme recall |
| `e2e/daimon-cli-memory-org` | Codex, Claude, Grok, and Agy CLI engines receiving schedule/dream memory context |
| `e2e/mixed-runtime-org` | Daimon, OpenClaw, and PicoClaw sharing Moltnet and Mneme wiring |
| `e2e/jungian-daimon-org` | Nested council topology, representative routing, and scoped memory bindings |

Simulation worlds, transcripts, clocks, and domain-specific orchestration do not
belong in this suite. They should consume Spawnfile as an external system and
test their own behavior in their owning project.

Generated output such as `.spawn/`, runtime logs, credentials, and run
transcripts must remain untracked.
