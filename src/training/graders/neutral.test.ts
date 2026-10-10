import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

it('enforces neutral grader imports through the actual repository lint gate', async () => {
  const eslint = new ESLint();
  for (const owner of ['inference', 'adapters', 'experiments', 'optimization', 'cli']) {
    const result = await eslint.lintText(`import '../${owner}/index.js';`, { filePath: 'src/graders/consensus.ts' });
    expect(result[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'structure/module-boundaries', messageId: 'neutral' }),
    ]));
  }
});
