import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../src/training/dspy/', import.meta.url));
const python = fileURLToPath(new URL('../src/training/dspy/.venv/bin/python', import.meta.url));
const environment = { ...process.env };
delete environment.TYPESAFE_API_KEY;

function run(args: readonly string[]): void {
  const result = spawnSync(python, args, { cwd, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['-m', 'pytest']);
run(['-c', `import json
from pathlib import Path
data = json.loads(Path('coverage.json').read_text())
summaries = [data['totals'], *[file['summary'] for file in data['files'].values()]]
assert all(s['covered_lines'] >= .9 * s['num_statements'] and
           s['covered_branches'] >= .9 * s['num_branches'] for s in summaries), \\
    'Every Python module and the total must reach 90% lines and branches'
print('COVERAGE: every module and total passed 90% lines and branches')
`]);
