// Tiny build-time highlighters for the landing's code samples. Output is HTML
// for `set:html`; input is escaped first.

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Spawnfile source: keys muted, punctuation dim, values left as ink.
export const spawnfile = (src: string): string =>
  escape(src)
    .replace(/([{}\[\]]+|^(\s*)-(?= ))/gm, (m) => `<span class="p">${m}</span>`)
    .replace(/([A-Za-z_][\w-]*):(?=\s|$)/gm, '<span class="k">$1:</span>');

// Shell transcript: `$` prompts dim, output lines muted.
export const shell = (src: string): string =>
  escape(src)
    .split('\n')
    .map((line) => (line.startsWith('$ ') ? `<span class="p">$</span>${line.slice(1)}` : `<span class="out">${line}</span>`))
    .join('\n');
