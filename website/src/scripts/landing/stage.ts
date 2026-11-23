// The view switch is native. Script connects matching rows and replays the example.
export function stage(): void {
  const demo = document.querySelector<HTMLElement>('.team-demo');
  if (!demo) return;

  const rows = [...demo.querySelectorAll<HTMLElement>('[data-peer]')];
  const peers = (row: HTMLElement) => row.dataset.peer!.split(' ');
  const highlight = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-peer]') : null;
    const active = row ? peers(row) : [];
    for (const item of rows) {
      item.classList.toggle('demo-highlight', peers(item).some((id) => active.includes(id)));
    }
  };
  demo.addEventListener('pointerover', (event) => highlight(event.target));
  demo.addEventListener('pointerleave', () => highlight(demo.contains(document.activeElement) ? document.activeElement : null));
  demo.addEventListener('focusin', (event) => highlight(event.target));
  demo.addEventListener('focusout', (event) => highlight(event.relatedTarget));

  const roster = demo.querySelector<HTMLDetailsElement>('.demo-roster');
  const outputs = [...demo.querySelectorAll<HTMLElement>('.demo-role, .demo-room')];
  const replay = () => {
    if (roster) roster.open = true;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const [i, output] of outputs.entries()) {
      output.getAnimations().forEach((animation) => animation.cancel());
      if (!reduceMotion) {
        output.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 270, delay: i * 80, fill: 'backwards' });
      }
    }
  };
  demo.querySelector('.demo-command')?.addEventListener('click', replay);
  demo.querySelector('#example-team-mode')?.addEventListener('change', replay);
}
