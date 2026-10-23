import { describe, expect, it } from 'vitest';
import { delta, escapeHtml, money, number, percent, shortId, shown, table } from './format.js';

describe('cockpit display values', () => {
  it('preserves measured zero and distinguishes absent values', () => {
    expect(shown(null)).toBe('Unknown');
    expect(shown(0)).toBe('0');
    expect(shown('recorded')).toBe('recorded');
    expect(number(null)).toBe('—');
    expect(number(1234.56)).toBe('1,234.6');
    expect(percent(null)).toBe('—');
    expect(percent(0)).toBe('0');
    expect(percent(0.857)).toBe('85.7');
  });

  it('shows signed percentage-point changes and exact versus ranged costs', () => {
    expect([null, -0.125, 0, 0.2].map(delta)).toEqual(['—', '−12.5', '0', '+20']);
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money({ low: 0, high: 0 })).toBe('$0.00');
    expect(money({ low: 1.234, high: 2.346 })).toBe('$1.23–2.35');
    expect(shortId('sha256:1234567890')).toBe('12345678');
    expect(shortId('run-a')).toBe('run-a');
  });

  it('escapes headers and every cell without creating active markup', () => {
    const hostile = `'"><img src=x onerror=alert(1)>&`;
    const escaped = '&#39;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;';
    expect(escapeHtml(hostile)).toBe(escaped);
    const html = table([hostile, 'Recorded'], [[hostile, '0'], ['Second', 'Unknown']]);
    expect(html).toContain(`<th scope="col">${escaped}</th>`);
    expect(html).toContain(`<td>${escaped}</td>`);
    expect(html).toContain('<td>0</td>');
    expect(html).not.toContain('<img');
    expect(table(['Score'], [])).toContain('No entries supplied.');
  });
});
