/**
 * Generates llms.txt and llms-full.txt from the docs content.
 * Run after `astro build` to place the files in dist/.
 *
 * llms.txt — index of all doc pages with titles and URLs
 * llms-full.txt — full markdown content of all docs concatenated
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const DOCS_DIR = new URL('../src/content/docs', import.meta.url).pathname;
const DIST_DIR = new URL('../dist', import.meta.url).pathname;
const SITE_URL = 'https://spawnfile.ai';

function walkDir(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.endsWith('.md') || entry.endsWith('.mdx')) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      fm[key.trim()] = rest.join(':').trim();
    }
  }
  return fm;
}

function getSlug(filePath) {
  let slug = relative(DOCS_DIR, filePath)
    .replace(/\.mdx?$/, '')
    .replace(/\/index$/, '');
  if (slug === 'index') slug = '';
  return slug;
}

const files = walkDir(DOCS_DIR).sort();

// Generate llms.txt (index)
const indexLines = [
  '# Spawnfile',
  '',
  '> A fully open-source spec and compiler for autonomous agents and teams. MIT licensed.',
  '',
  '## Documentation',
  '',
];

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const fm = extractFrontmatter(content);
  const slug = getSlug(file);
  const url = slug ? `${SITE_URL}/${slug}/` : `${SITE_URL}/`;
  const title = fm.title || slug || 'Home';
  indexLines.push(`- [${title}](${url})`);
}

indexLines.push('', '## Source', '', '- GitHub: https://github.com/noopolis/spawnfile', '- License: MIT', '');

writeFileSync(join(DIST_DIR, 'llms.txt'), indexLines.join('\n'));

// Generate llms-full.txt (all content)
const fullLines = [
  '# Spawnfile — Full Documentation',
  '',
  '> A fully open-source spec and compiler for autonomous agents and teams.',
  '',
];

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const fm = extractFrontmatter(content);
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  const title = fm.title || getSlug(file) || 'Home';

  fullLines.push(`---`, '', `# ${title}`, '', body.trim(), '', '');
}

writeFileSync(join(DIST_DIR, 'llms-full.txt'), fullLines.join('\n'));

console.log(`Generated llms.txt (${files.length} pages) and llms-full.txt`);
