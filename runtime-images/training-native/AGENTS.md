# Training native parent

- `Dockerfile` is a template rendered by `scripts/training-native-image.ts`.
  The CI entrypoint is `scripts/publish-training-native.ts`.
- Reuse the compiled organization Daimon install verification/launcher commands.
  Consume only the root runtime and Moltnet authorities; refuse incomplete pins.
- Keep the Bookworm Node base pinned by digest. Consumers pin the published
  image digest, so apt resolves from the current signed Bookworm repositories.
- Keep the Paideia native adapter's ancestor node_modules link. Do not install
  evaluator CLIs or re-check Mneme versions outside the runtime receipt contract.
- Training declarations should pin the published parent digest in
  `image.build.nativeImage`, never a mutable tag.
