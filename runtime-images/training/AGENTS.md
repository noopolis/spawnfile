# Training image

Owns the single-container training dependency recipe. Spawnfile launches and
stops the outer container; Paideia supervises experiments and native trial child
processes inside it. No Docker socket or host home is mounted.

Build inputs are explicit package distributions, locked dependency manifests,
verified native executables and an installed integration entrypoint. Credentials,
cases and results are runtime mounts, never image contents. Native runtime and
Python base images must be immutable. Do not download unpinned CLI installers.
The recipe is opt-in during incubation; no published runtime is implied.
