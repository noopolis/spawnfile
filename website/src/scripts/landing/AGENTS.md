# Landing Scripts Guide

Behavior for the landing page; `index.ts` is the single entry imported by
`src/pages/index.astro`.

- `content.ts`: copyable setup prompt and install command.
- `stage.ts` highlights matching Docker roles and replays the selected example. The scope and file controls also work with scripts disabled.
- `rooms.ts`: showcase card; reads live room activity from a public read-only mirror.
- `chrome.ts`: sticky nav rule, copy buttons, toast, GitHub star count.
