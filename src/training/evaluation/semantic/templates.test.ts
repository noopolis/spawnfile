import { describe, expect, it } from 'vitest';
import { renderJudgeTemplate, validateJudgeTemplate } from './templates.js';

const template = (text: string) => ({ language: 'jinja' as const, text });

describe('bounded real Jinja judge templates', () => {
  it('renders actual conditions, loops, macros and filters', async () => {
    await expect(renderJudgeTemplate(template(`{% macro item(value) %}[{{ value | upper }}]{% endmacro %}
{% if rubric %}{% for word in rubric.split(' ') %}{{ item(word) }}{% endfor %}{% endif %}`), 'plain prose'))
      .resolves.toContain('[PLAIN][PROSE]');
  });
  it('does not interpret values as template source', async () => {
    await expect(renderJudgeTemplate(template('{{ rubric }}'), '{{ 7 * 7 }}')).resolves.toBe('{{ 7 * 7 }}');
    await expect(renderJudgeTemplate(template('Fixed instruction'), 'criterion')).resolves.toBe('Fixed instruction');
  });
  it('validates syntax without executing loops', async () => {
    await expect(validateJudgeTemplate(template('{% for x in range(1000000000) %}x{% endfor %}'))).resolves.toBeUndefined();
    await expect(validateJudgeTemplate(template('{% broken %}'))).rejects.toThrow('rendering failed');
  });
  it.each(['{% include "secret" %}', '{{ process.exit() }}', '{{ strftime_now("%Y") }}', '{{ rubric.no_such_method() }}'])('rejects unsupported execution: %s', async text => {
    await expect(renderJudgeTemplate(template(text), 'criterion')).rejects.toThrow('rendering failed');
  });
  it('bounds source, rubric and output sizes', async () => {
    await expect(renderJudgeTemplate(template('x'.repeat(32769)), '')).rejects.toThrow('oversized');
    await expect(renderJudgeTemplate(template('{{ rubric }}'), 'x'.repeat(131073))).rejects.toThrow('oversized');
    await expect(renderJudgeTemplate(template('{{ rubric * 3 }}'), 'x'.repeat(100000))).rejects.toThrow('rendering failed');
    await expect(renderJudgeTemplate(template(' '), '')).rejects.toThrow('Invalid');
    await expect(renderJudgeTemplate({ language: 'wrong' as 'jinja', text: 'x' }, '')).rejects.toThrow('Invalid');
  });
  it('honors cancellation before and during rendering', async () => {
    await expect(renderJudgeTemplate(template('x'), '', AbortSignal.abort())).rejects.toThrow('cancelled');
    const controller = new AbortController();
    const rendering = renderJudgeTemplate(template('x'), '', controller.signal);
    controller.abort();
    await expect(rendering).rejects.toThrow('cancelled');
  });
  it('terminates expensive render work at its deadline', async () => {
    await expect(renderJudgeTemplate(template('{% for x in range(100000) %}{% for y in range(100000) %}{% set z = x + y %}{% endfor %}{% endfor %}'), ''))
      .rejects.toThrow(/timed out|rendering failed/);
  });
});
