# Spawnfile website

The landing page and documentation for [spawnfile.com](https://spawnfile.com), built
with Astro and Starlight.

```bash
npm ci
npm run dev      # local server at http://localhost:4321
npm run build    # dist/, plus llms.txt and raw markdown
npm run images   # favicon PNGs from public/favicon.svg
```

- `src/pages/index.astro`: the landing page, composed from `src/components/landing/`.
- `src/content/docs/`: documentation pages.
- `src/styles/tokens.css`: the palette, shared by the landing page and the docs.
- `scripts/og-card.html`: source of `public/og.png`; render it at 1200x630 with a
  headless browser after changing the headline.
