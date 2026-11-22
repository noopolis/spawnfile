import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { parse, serialize, type DefaultTreeAdapterTypes as Html } from 'parse5';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const dist = join(root, 'website/dist');

function* elements(node: Html.Node): Generator<Html.Element> {
  if ('tagName' in node) yield node;
  if ('childNodes' in node) {
    for (const child of node.childNodes) yield* elements(child);
  }
}

const attr = (element: Html.Element, name: string) => element.attrs.find((entry) => entry.name === name)?.value;
const homepage = [...elements(parse(readFileSync(join(dist, 'index.html'), 'utf8')))];

test('every active harness has a linked guide and its published install pin on the homepage', () => {
  const registry = load(readFileSync(join(root, 'runtimes.yaml'), 'utf8')) as {
    runtimes: Record<string, { status: string; ref: string; install: { tag?: string; version?: string } }>;
  };
  const section = homepage.find((element) => attr(element, 'id') === 'harnesses');
  assert.ok(section);
  const rows = [...elements(section)].filter((element) => element.tagName === 'tr');
  const active = Object.entries(registry.runtimes).filter(([, runtime]) => runtime.status === 'active');
  assert.equal(rows.length, active.length + 1);
  for (const [id, { ref, install }] of active) {
    const href = `/runtimes/${id}/`;
    const row = rows.find((row) => [...elements(row)].some((el) => attr(el, 'href') === href));
    assert.ok(row && existsSync(join(dist, href, 'index.html')), `missing guide for ${id}`);
    assert.ok(serialize(row).includes(`<code>${install.tag ?? install.version ?? ref}</code>`), `wrong pin for ${id}`);
  }
});

test('the interactive team matches the roles and native files produced by spawnfile compile', (context) => {
  const out = mkdtempSync(join(tmpdir(), 'spawnfile-homepage-'));
  context.after(() => rmSync(out, { recursive: true, force: true }));
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'compile', 'examples/research-org', '-o', out], { cwd: root });
  const report = JSON.parse(readFileSync(join(out, 'spawnfile-report.json'), 'utf8')) as {
    nodes: { kind: string; id: string; runtime: string }[];
  };
  const paths = homepage.flatMap((node) => attr(node, 'data-path') ?? []);
  const shown = homepage.filter((node) => attr(node, 'data-runtime'));
  const listed = homepage.flatMap((el) => attr(el, 'data-harness') ?? []);
  assert.deepEqual(shown.map((el) => attr(el, 'data-runtime')).sort(), listed.sort());
  const agents = report.nodes.filter((node) => node.kind === 'agent');
  assert.equal(shown.length, agents.length);
  for (const { id, runtime } of agents) {
    const name = id.slice('agent:'.length);
    assert.ok(shown.some((el) => attr(el, 'data-runtime') === runtime && attr(el, 'data-g') === name), `missing ${id}`);
    assert.ok(paths.some((path) => path.startsWith(`runtimes/${runtime}/agents/${name}/`)), `missing files for ${id}`);
  }
  for (const path of paths) assert.ok(existsSync(join(out, path)), `missing compiled file ${path}`);
});
