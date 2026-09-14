# Experiment cockpit

Own the visual console, SVG charts and browser interactions. Follow the Moltnet
console's header, sidebar, outlined panels, bracketed legends and status strip.
Keep an outcome, numeric comparison and charts visible before detailed evidence.

- Consume `viewer/metrics` and the authorized `ViewerData` projection only.
  No experiments, inference, raw storage, prompts or private tool payloads.
- Charts distinguish raw metrics, required gates and optimizer reward. Plot
  measured points only; missing data is a gap and unequal case coverage is visible.
- Escape all data in HTML/SVG. Controls only select presentation or refresh GETs.
- Keep evidence collapsed and navigation usable at narrow widths and by keyboard.
- The document and shell stay exactly viewport-height. The sidebar and navigation
  never scroll; bounded data panels own overflow, with their headings kept visible.
  Check actual panel containment and readable content space, not just hidden overflow.
  Use one fixed scale: sidebar/controls/labels 12px, body 13px, headings 16px,
  primary metrics 24px. Mobile changes spacing and scroll ownership, never shrinks
  text below that scale. Short screens scroll the content pane rather than squash charts.
- Test real score geometry, missing data, hostile labels and controls. Verify the
  actual captured run in a browser at desktop and mobile before the final gate.
- At most three implementation/review rounds and two final cleanup rounds.
  Do not tune criteria or agent instructions to make the charts look better.

- Trial trend uses chronological development trial ordinals, case/candidate point
  labels and separate train/validation styles. Repeated prompt identities remain
  distinct measurements. Candidate comparison remains paired by case, separately;
  a changing trial curve across different cases is not proof of convergence.
