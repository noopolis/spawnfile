# Landing Scripts Guide

Behavior for the landing page; `index.ts` is the single entry imported by
`src/pages/index.astro`.

- `content.ts`: shared copy (setup prompt, install command) and the hero stage
  data: example Spawnfile lines, the compiled output tree and hover captions.
- `stage.ts`: the hero stage; links rows by group on hover or tap and plays
  compile then up once. Shows the finished state under reduced motion.
- `rooms.ts`: showcase card; reads live room activity from a public read-only mirror.
- `chrome.ts`: sticky nav rule, copy buttons, toast, GitHub star count.
- `motion.ts`: reduced-motion check and sleep.

The stage output tree must mirror a real `spawnfile compile` of the example org.
