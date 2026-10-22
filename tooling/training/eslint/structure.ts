import type { Rule } from 'eslint';
import { canonicalPath, implementationRoots, inside, pathParts } from './paths.js';
import { inspectLayout } from './layout.js';

export const lineTarget: Rule.RuleModule = {
  meta: { type: 'suggestion', schema: [], messages: { large: 'This file has {{count}} lines; split by responsibility before the 400-line target.' } },
  create(context) {
    return { Program(node) {
      const lines = context.sourceCode.lines;
      // Match ESLint max-lines: a conventional final LF does not add an empty line.
      const count = lines.length - (lines.at(-1) === '' ? 1 : 0);
      if (count > 400) context.report({ node, messageId: 'large', data: { count } });
    } };
  },
};

export const directoryStructure: Rule.RuleModule = {
  meta: { type: 'problem', schema: [], messages: {
    guide: '{{directory}} needs a nonempty AGENTS.md and a relative CLAUDE.md symlink to that local guide.',
    crowded: '{{directory}} has {{count}} direct maintained files; split before exceeding 30.',
    language: 'Maintained implementation code must be TypeScript.',
  } },
  create(context) {
    return { Program(node) {
      const filename = canonicalPath(context.physicalFilename);
      const root = canonicalPath(context.cwd);
      const parts = pathParts(root, filename);
      if (!inside(root, filename) || !implementationRoots.has(parts[0] ?? '')) return;
      if (/\.[cm]?jsx?$/.test(filename)) context.report({ node, messageId: 'language' });
      // Scan all managed directories, including data-only fixtures with no lintable file.
      for (const violation of inspectLayout(root)) context.report({ node, ...violation });
    } };
  },
};
