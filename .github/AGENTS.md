# Repository automation

Owns CI workflows and opt-in commit policy tooling. No application code.

The `runtime-images.yml` training-native job builds both architectures from
checked-in root pins, serializes publication across refs, and uploads the exact
published digest. PRs never push; only version tags or explicit dispatch push
do. It intentionally has no latest/force path.
