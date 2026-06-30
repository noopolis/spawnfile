# Templates Guide

This folder contains draft Spawnfile templates.

Templates are source scaffolds, not compiler inputs yet. A future template
command should expand these files into ordinary Spawnfile projects or subtrees.
After expansion, the generated Spawnfile source is the source of truth.

Keep templates readable and conservative:

- Use `template.yaml` for metadata and parameters.
- Put expandable source under `files/`.
- Use `{{name}}` placeholders only in template source.
- Keep examples focused on authored Spawnfile files, not generated `.spawn`
  output.
- Do not make template expansion part of `spawnfile compile`.
