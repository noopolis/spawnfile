import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('metrics derived from a bounded valid viewer projection', () => {
  it('processes 1,000 distinct candidate metrics within a real 256 MiB child heap', () => {
    const projection = new URL('../projection.ts', import.meta.url).href;
    const metrics = new URL('./index.ts', import.meta.url).href;
    const script = `
      import { projectViewerData } from ${JSON.stringify(projection)};
      import { buildCockpitMetrics } from ${JSON.stringify(metrics)};
      const check = id => ({ id, label:id, status:'pass', score:0.5, evidenceIds:[], children:[] });
      const data = { schema:'paideia.viewer.v1', experiment:{ id:'bounds', title:'Synthetic bound',
        status:'completed', phase:'replay', updatedAt:'recorded' },
        cases:[{ id:'case', split:'train' }], candidates:[], trials:[], usage:[] };
      for (let i=0; i<1000; i++) {
        const id='c'+i;
        data.candidates.push({ id, parentIds:[], validationScore:null, discoveryEvaluations:0, editablePaths:[] });
        data.trials.push({ id:'t'+i, caseId:'case', candidateId:id, status:'pass', score:0.5, coverage:[],
          checks:[{ ...check('stage'+i), children:[check('check'+i)] }], events:[] });
      }
      const accepted = projectViewerData(data);
      console.log('PROJECTION_ACCEPTED');
      const result = buildCockpitMetrics(accepted);
      console.log(JSON.stringify({ scores:result.scores.length, comparisons:result.comparisons.length,
        gates:result.gates.length, trialIndex:result.trialIndex.length }));
    `;
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('PROJECTION_ACCEPTED');
    expect(JSON.parse(child.stdout.trim().split('\n').at(-1)!)).toEqual({ scores:3000, comparisons:999, gates:1000, trialIndex:1000 });
  });
});
