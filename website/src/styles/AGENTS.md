# Website Styles Guide

Site-wide CSS only.

- `tokens.css`: the palette and fonts, shared by the landing page and the docs.
  Neutral base; blueprint (`--sig`) only for small marks. Green means live.
- `fonts.css`: self-hosted font faces (files in `public/fonts/`) and width-matched
  fallbacks, imported by `tokens.css`. Do not load fonts from another host.
- `custom.css`: Starlight docs theme built on the tokens.
- `landing.css`: entry for the landing page; imports the `landing-*.css` files.
- `landing-base.css`: nav, headings, buttons, the `[ ]` bracket frame, code samples, footer, toast.
- `landing-hero.css`: hero and the three-column stage, its row linking and playback states.
- `landing-sections.css`: sections, harness table, closing and showcase.
- `landing-responsive.css`: narrow layouts; phones are the main audience.

Keep files under 400 lines and the palette small.
