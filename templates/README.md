# Spawnfile Templates

Templates are reusable source scaffolds for Spawnfile organizations, teams,
agents, skills, and memory systems.

The intended future flow is:

```bash
spawnfile template list
spawnfile add team luna --template @noopolis/jungian-composite-agent
spawnfile add agent keeper --template @noopolis/memory-keeper
```

Template expansion should write ordinary source files:

```text
Spawnfile
TEAM.md
agents/*/Spawnfile
agents/*/AGENTS.md
agents/*/MEMORY.md
```

The compiler should compile the expanded files. It should not fetch or interpret
remote templates during compile.

## Current Drafts

- `jungian-composite-agent`: a composite agent exposed through one public
  representative, with internal archetype agents consulting in a private Moltnet
  room.
