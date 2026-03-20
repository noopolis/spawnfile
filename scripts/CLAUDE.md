# Scripts Guidance

## Structure

```text
scripts/
├── install.sh   # Local bootstrap/install flow for the CLI
└── CLAUDE.md    # Guidance for scripts in this folder
```

This folder should stay small. If we add more scripts, each should exist for one clear repo workflow.

- Keep scripts small, portable, and composable.
- Prefer POSIX shell for bootstrap/install scripts unless a runtime-specific tool is required.
- Scripts should fail fast with clear messages and avoid hidden side effects.
- When a script grows beyond a few straightforward steps, split logic into separate files rather than building a long shell program.
