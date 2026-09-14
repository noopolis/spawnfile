import { expect, it } from 'vitest';
import { liveActivity } from './activity.js';
import { viewerFixture } from '../fixture.js';

it('renders observed tool/judge counts, criterion weights, gate verdicts and missing scores honestly',()=>{
  const data=viewerFixture();expect(liveActivity(data)).toBe('');
  data.activity={trialId:'trial',caseId:'case <script>',phase:'train',status:'Evaluating <img>',toolCalls:4,judgeCalls:2,
    measurements:[{stageId:'writing "onload',criterionId:'clarity <script>',kind:'criterion',status:'pass',score:0.9,weight:2},
      {stageId:'writing',criterionId:'gate',kind:'gate',status:'fail <img>',score:0},
      {stageId:'writing',criterionId:'unknown',kind:'score',status:'unknown',score:null}]};
  const html=liveActivity(data);
  expect(html).toContain('<strong>4</strong>');expect(html).toContain('<strong>2</strong>');
  expect(html).toContain('<strong>90</strong>');expect(html).toContain('2×');expect(html).toContain('fail &lt;img&gt;');
  expect(html).toContain('—');expect(html).not.toMatch(/<script>|<img>/);
  expect(html).toContain('writing &quot;onload');
});
