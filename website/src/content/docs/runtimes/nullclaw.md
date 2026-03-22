---
title: NullClaw
description: NullClaw runtime -- exploratory status, config surface, MCP handling, delegate agents, and what an adapter would emit.
---

NullClaw is an exploratory Spawnfile runtime. Research confirms its config + markdown workspace model is compatible with Spawnfile, but no adapter has been implemented yet.

**Status:** Exploratory

## Config Shape

NullClaw uses a JSON configuration file at `~/.nullclaw/config.json` with an OpenClaw-compatible config structure. It supports markdown identity plus optional AIEOS identity and has a strong runtime abstraction layer.

## Workspace Layout

NullClaw has a workspace directory structure similar to OpenClaw. Spawnfile doc roles would map to workspace markdown files following the same pattern as the active runtimes.

## Skills

NullClaw has first-class skills, but its format is richer than the pure Spawnfile assumption:

- The skill loader uses TOML manifests plus `SKILL.md`
- A workspace skill directory exists

An adapter would need to preserve `SKILL.md` and potentially synthesize the TOML sidecar or manifest data that NullClaw expects alongside it.

## MCP Handling

NullClaw supports MCP with a **stdio-first** approach:

- stdio MCP servers via `command` + `args` are clearly supported
- Remote MCP URLs are not loaded directly from `mcp_servers` -- they may require a local bridge

This means Spawnfile's `stdio` transport maps well, but `streamable_http` and `sse` transports may need adapter-specific bridging.

## Model and Auth

NullClaw uses an OpenClaw-compatible config layout for providers and defaults:
- Named agents can override the model
- Multiple token and gateway auth modes exist

Primary and fallback execution model intent should map reasonably well. Auth configuration remains adapter-specific.

## Workspace and Sandbox

NullClaw has:
- Explicit workspace scoping
- Multiple sandbox backends
- Allowlists and protected paths

This is a strong fit for Spawnfile's `execution.workspace` and `execution.sandbox` intent.

## Teams and Routing

NullClaw has:
- Route bindings
- Named agents
- A delegate tool
- A subagent manager

It does not have a strong user-facing team object. An adapter would:
- Lower teams into named agents plus route bindings
- Use delegate or subagent patterns for member coordination
- Report degradation for nested teams

## What An Adapter Would Emit

When an adapter is implemented, it would likely emit:
- A NullClaw JSON config file
- Workspace markdown files mapped from doc roles
- Skill directories with `SKILL.md` (and synthesized TOML manifests)
- stdio MCP server configuration
- Named agent configurations for team members

## Open Questions

- How AIEOS structured identity interacts with markdown docs -- can both coexist in a compiled workspace?
- Exact MCP surface for remote (non-stdio) MCP integrations

## Contributing

NullClaw is a good candidate for a new adapter. If you are interested in implementing it, see [Adding a Runtime](/contributing/adding-a-runtime/) for the adapter lifecycle and requirements.
