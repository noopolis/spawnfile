# Jungian Daimon Org

This fixture models two Jungian selves:

- **Luna** (Codex representative, with an Agy archetype)
- **Selene** (Grok representative, with a grounded support archetype)

The top-floor room is `commons` on `psyche-floor`; only team representatives are members there.
Each representative must consult its inner council room before answering:

- `luna-council` for Luna
- `selene-council` for Selene

Use this seed for live wake checks:

1) Post one message containing `SF-JUNGIAN-SEEK` in `commons`.
2) The appropriate representative should route to its council room, collect one short grounded reply, and then answer in `commons`.

Each council declares a durable Mneme bank. The fixture verifies that the
compiler maps those banks into the legacy generated-Pi runtime and preserves the
inner council room topology used for consultation and dream wakes.
