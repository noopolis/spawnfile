import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./dspy/', import.meta.url));
const destination = fileURLToPath(new URL('../../dist/training/dspy/', import.meta.url));
const aliasResource = 'spawnfile_training_dspy/legacy_wire_aliases.json';
const rootFiles = new Set([
  'pyproject.toml', 'requirements.lock', 'README.md', 'protocol.md', 'AGENTS.md', 'CLAUDE.md',
]);

await mkdir(destination, { recursive: true });
await cp(source, destination, {
  recursive: true,
  verbatimSymlinks: true,
  filter: (entry) => {
    const parts = relative(source, resolve(entry)).split(sep);
    if (parts[0] === '') return true;
    if (parts.length === 1 && rootFiles.has(parts[0]!)) return true;
    if (parts[0] !== 'spawnfile_training_dspy' || parts.join('/') === aliasResource) return false;
    return !parts.some((part) => part.startsWith('.') || part === '__pycache__' || part.endsWith('.egg-info')) &&
      !basename(entry).endsWith('_test.py') && !basename(entry).endsWith('.pyc');
  },
});

// The image installs the bridge before copying the rest of dist/training. Ship a
// self-contained resource while retaining exactly one maintained source table.
await rm(join(destination, aliasResource), { force: true });
await copyFile(join(source, aliasResource), join(destination, aliasResource));

// The viewer embeds its HTML, CSS and client script in TypeScript; tsc emits its assets.
