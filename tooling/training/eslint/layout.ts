import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { generatedDirectories, implementationRoots } from './paths.js';

type LayoutViolation = { messageId: 'guide' | 'crowded'; data: { directory: string; count?: number } };

export function inspectLayout(root: string): LayoutViolation[] {
  const violations: LayoutViolation[] = [];
  const pending = [...implementationRoots].map((name) => path.join(root, name)).filter((directory) => existsSync(directory));
  for (const directory of pending) {
    const guide = path.join(directory, 'AGENTS.md');
    const link = path.join(directory, 'CLAUDE.md');
    const label = path.relative(root, directory);
    const valid = existsSync(guide) && lstatSync(guide).isFile() && readFileSync(guide, 'utf8').trim().length > 0 &&
      existsSync(link) && lstatSync(link).isSymbolicLink() && !path.isAbsolute(readlinkSync(link)) &&
      path.resolve(directory, readlinkSync(link)) === guide;
    if (!valid) violations.push({ messageId: 'guide', data: { directory: label } });
    const entries = readdirSync(directory, { withFileTypes: true });
    const count = entries.filter((entry) => !entry.isDirectory() && entry.name !== '.DS_Store').length;
    if (count > 30) violations.push({ messageId: 'crowded', data: { directory: label, count } });
    pending.push(...entries.filter((entry) => entry.isDirectory() && !generatedDirectories.has(entry.name))
      .map((entry) => path.join(directory, entry.name)));
  }
  return violations;
}
