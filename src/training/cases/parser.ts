import { createHash } from 'node:crypto';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { Node } from 'yaml';
import type { DatasetDocument } from '../contracts/dataset.js';
import { validateDataset } from './schema.js';
import { fail } from './validation.js';

export function parseDatasetYaml(source: string, options: { sourceName?: string } = {}): DatasetDocument {
  const sourceName = options.sourceName ?? '<dataset>';
  if (Buffer.byteLength(source) > 2_000_000) fail(sourceName, 'dataset exceeds 2 MB');
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, uniqueKeys: true, version: '1.2', merge: false });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length) fail(sourceName, problems.map(error => error.message).join('\n'));
  const locations: DatasetDocument['locations'] = {};
  let count = 0;
  function visit(node: Node | null | undefined, path: string, depth: number): void {
    if (++count > 50_000 || depth > 64) fail(path, 'dataset node/depth resource limit exceeded');
    if (!node) return;
    if (isAlias(node)) fail(path, 'YAML aliases are unsupported; use named fixtures');
    if (node.range) {
      const position = lineCounter.linePos(node.range[0]);
      locations[path] = { line: position.line, column: position.col };
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail(path, 'mapping keys must be strings');
        visit(pair.value as Node, `${path}.${pair.key.value}`, depth + 1);
      }
    }
    if (isSeq(node)) node.items.forEach((item, index) => visit(item as Node, `${path}[${index}]`, depth + 1));
  }
  visit(document.contents, '$', 0);
  return {
    dataset: validateDataset(document.toJS({ maxAliasCount: 0 })),
    sourceName,
    sourceDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
    locations,
  };
}
