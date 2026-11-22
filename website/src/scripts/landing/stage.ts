// The hero stage: hover or tap a row to light up what it becomes, and play
// `spawnfile compile` then `spawnfile up` once on load. Both commands replay on click.
import { STAGE_CAPTIONS, STAGE_IDLE } from './content';
import { reducedMotion, sleep } from './motion';

const groups = (el: HTMLElement): string[] => (el.dataset.g ?? '').split(' ');

export function stage(): void {
  const root = document.getElementById('stage');
  const cap = document.getElementById('stage-cap');
  if (!root || !cap) return;
  const all = <T extends HTMLElement = HTMLElement>(sel: string, from: ParentNode = root) => [...from.querySelectorAll<T>(sel)];

  const linked = all('[data-g]');
  const focus = (el: HTMLElement | null) => {
    const active = el ? groups(el) : [];
    root.classList.toggle('focus', active.length > 0);
    for (const n of linked) n.classList.toggle('hit', groups(n).some((g) => active.includes(g)));
    cap.innerHTML = el ? (STAGE_CAPTIONS[el.dataset.g ?? ''] ?? STAGE_CAPTIONS[active[0]] ?? STAGE_IDLE) : STAGE_IDLE;
  };
  for (const n of linked) {
    n.addEventListener('mouseenter', () => focus(n));
    n.addEventListener('focus', () => focus(n));
    n.addEventListener('click', (e) => { e.stopPropagation(); focus(n); });
  }
  root.addEventListener('mouseleave', () => focus(null));
  root.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) focus(null);
  });
  document.addEventListener('click', () => focus(null));

  const [srcCol, outCol, runCol] = all('.col');
  const step = (col: HTMLElement) => col.querySelector('.step')!;
  const finish = () => { step(outCol).classList.add('on'); step(runCol).classList.add('on'); root.classList.add('live'); };
  if (reducedMotion()) return finish();

  let token = 0;
  const compile = async (t: number): Promise<boolean> => {
    all('.o').forEach((n) => n.classList.remove('in'));
    step(runCol).classList.remove('on');
    root.classList.remove('live');
    step(outCol).classList.add('on');
    const src = all('.row', srcCol);
    const out = all('.o', outCol);
    for (let i = 0; i < Math.max(src.length, out.length); i++) {
      if (t !== token) return false;
      src.forEach((r, j) => r.classList.toggle('scan', j === i));
      out[i]?.classList.add('in');
      await sleep(85);
    }
    src.forEach((r) => r.classList.remove('scan'));
    return t === token;
  };
  const up = async (t: number): Promise<void> => {
    all('.o', outCol).forEach((n) => n.classList.add('in'));
    all('.o', runCol).forEach((n) => n.classList.remove('in'));
    step(outCol).classList.add('on');
    step(runCol).classList.add('on');
    for (const n of all('.o', runCol)) {
      if (t !== token) return;
      n.classList.add('in');
      await sleep(n.classList.contains('team') ? 60 : 170);
    }
    if (t === token) root.classList.add('live');
  };
  const play = async (from: string | undefined): Promise<void> => {
    const t = ++token;
    if (from === 'up') return up(t);
    if (await compile(t)) { await sleep(350); if (t === token) await up(t); }
  };

  root.classList.add('anim');
  window.setTimeout(() => void play('compile'), 700);
  all('[data-run]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); void play(b.dataset.run); }));
}
