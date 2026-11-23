# Landing Scripts Guide

Behavior for the landing page; `index.ts` is the single entry imported by
`src/pages/index.astro`.

- `content.ts`: copyable setup prompt and install command.
- `stage.ts`: highlight the source and matching Docker roles, and replay startup on request. The mobile view switch works with scripts disabled.
- `rooms.ts`: showcase card; reads live room activity from a public read-only mirror.
- `chrome.ts`: sticky nav rule, copy buttons, toast, GitHub star count.
