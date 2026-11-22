# Landing Components Guide

One component per landing section, composed by `src/pages/index.astro`.
Styles live in `src/styles/landing-*.css`; behavior in `src/scripts/landing/`.

- `LandingNav.astro`, `LandingFooter.astro`: page chrome.
- `Hero.astro`: positioning headline, calls to action and the stage.
- `Stage.astro`: example Spawnfile, compiled output tree and running org, linked row by row.
- `Format.astro`, `Shared.astro`, `Compile.astro`, `Run.astro`, `Harnesses.astro`,
  `Boundaries.astro`, `Train.astro`, `Closing.astro`: sections below the hero.
- `Showcase.astro`: "Built with Spawnfile" strip, one card per real organization.
- `Cta.astro`: copy-setup-prompt button and install command, used by the hero and closing.
- `Panel.astro`: a code sample in the bracket frame.
- `harnesses.ts`: joins the active registry pins to the corresponding runtime guides.
- `highlight.ts`: build-time highlighters for Spawnfile source and shell transcripts.

The product is the Spawnfile format; copy never calls it YAML. Every harness, engine,
login or command shown here must match `specs/RUNTIMES.md` and the CLI. Use `<pre>`
for preformatted text; Astro compresses whitespace elsewhere.
