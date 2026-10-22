# Evaluation Environment Sources

Owns the example's prompt seeds. The parent Spawnfile declares public/private source
revisions, MCP tools, workspace mounts and the memory backend.

- These files are synthetic prompt source written for this example. Replacing them
  with a real agent's instructions would put private prompt material in this repo.
- Prompt candidates are isolated overlays; preserve native and mirrored references.
- Child AGENTS.md files are runtime prompts, not development guides. Their CLAUDE.md
  links are compatibility aliases; do not inject contributor rules into the subject.
- Real source bytes, generated tool closures, credentials and trial state stay
  outside Git. Keep provenance and remaining fidelity gaps in the single README.
- Keep the prompt seeds and the MCP/model/memory declarations consistent with each
  other; a project applying this shape compares them against its own pinned source.
