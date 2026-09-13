export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[character]!);
}

export function shown(value: string | number | null): string { return value === null ? 'Unknown' : String(value); }

export function number(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

export function percent(value: number | null): string { return value === null ? '—' : number(value * 100); }

export function delta(value: number | null): string {
  return value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value) * 100)}`;
}

export function shortId(value: string): string { return value.replace(/^sha256:/, '').slice(0, 8); }

export function money(value: { low: number; high: number } | null | undefined): string {
  if (value == null) return '—';
  return value.low === value.high ? `$${value.low.toFixed(2)}` : `$${value.low.toFixed(2)}–${value.high.toFixed(2)}`;
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty-state">No entries supplied.</p>';
  return `<div class="scroll"><table class="compact-table"><thead><tr>${headers.map(value => `<th scope="col">${escapeHtml(value)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
