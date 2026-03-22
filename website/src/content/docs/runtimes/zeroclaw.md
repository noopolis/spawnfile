---
title: ZeroClaw
description: ZeroClaw runtime -- exploratory status, TOML config, auth model, delegate sub-agents, and what an adapter would emit.
---

ZeroClaw is an exploratory Spawnfile runtime. Research confirms its config + markdown workspace model is compatible with Spawnfile, but no adapter has been implemented yet.

**Status:** Exploratory

## Config Shape

ZeroClaw uses a TOML configuration file at `~/.zeroclaw/config.toml`. It supports markdown identity or AIEOS JSON identity, and has a strong provider/auth story.

This is the only current Spawnfile target that uses TOML instead of JSON for its config format.

## Workspace Layout

ZeroClaw has a workspace directory for markdown docs. Spawnfile doc roles would map to workspace files following the same pattern as the active runtimes.

## Skills

ZeroClaw has first-class skills:
- Open-skills sync is opt-in
- Installs are statically audited

An adapter would preserve `SKILL.md` and handle registry behavior and install audit settings as adapter-specific concerns.

## MCP Handling

ZeroClaw mentions MCP in provider/runtime documentation, but the surface is more mixed than PicoClaw's direct server map. The exact user-facing MCP server config surface for non-provider MCP integrations is still an open research question.

An adapter would need to map the MCP compile surface more concretely before implementation.

## Model and Auth

ZeroClaw has one of the best auth stories among the supported runtimes:
- Auth profiles support subscription-native flows
- Delegate sub-agents have their own provider, model, and tool settings

This makes it one of the strongest targets for execution model intent. The adapter would map both primary and fallback models with high fidelity.

## Workspace and Sandbox

ZeroClaw has:
- Explicit workspace-only controls
- Optional Docker runtime
- Allowed roots outside workspace

This is a strong fit for Spawnfile's `execution.workspace` and `execution.sandbox` intent.

## Teams and Routing

ZeroClaw does not expose native teams. What it does expose:

- Named delegate sub-agents under `[agents.<name>]`
- Recursion depth controls
- Tool allowlists
- Agentic or single-turn delegate modes

An adapter would:
- Lower Spawnfile teams into named delegate agents
- Preserve delegate relationships well
- Report degradation for nested teams and full broadcast semantics

## What An Adapter Would Emit

When an adapter is implemented, it would likely emit:
- A ZeroClaw TOML config file
- Workspace markdown files mapped from doc roles
- Skill directories with `SKILL.md`
- Named delegate agent sections (e.g. `[agents.researcher]`)
- Provider and model configuration

## Open Questions

- Exact user-facing MCP server config surface for non-provider MCP integrations
- How swarms (sequential/parallel/router strategies) relate to the Spawnfile team model

## Contributing

ZeroClaw is a good candidate for a new adapter. If you are interested in implementing it, see [Adding a Runtime](/contributing/adding-a-runtime/) for the adapter lifecycle and requirements.
