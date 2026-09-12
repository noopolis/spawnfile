# Spawnfile boundary audit

Current-tree audit accompanying the architecture, public API, and YAML-model diagrams.

## Boundary conclusion

The new public Daimon path no longer executes Codex, Grok, or AGY inside Spawnfile. Spawnfile compiles the organization and Daimon configuration; Daimon owns agent execution.

The migration is not operationally complete. Credential provisioning and wake ingress remain missing from the live public Daimon path, while several legacy Pi-shaped integration surfaces still describe or inspect Daimon incorrectly.

## P0 — critical

- **No Daimon engine credentials:** Spawnfile creates empty agent runtime homes but has no public provisioning path for Daimon's required Codex, Grok, or AGY credential artifacts. A real Daimon deployment cannot pass engine readiness.
- **No usable Daimon wake ingress:** the live path rejects schedules, Moltnet, and other surfaces; exposes no Spawnfile wake operation; and binds the host to container loopback. A running host cannot perform useful work.

## P1 — correctness

- `run` promises compile, build, and run but does not build the image.
- Dev, status, and dormant Moltnet lowering still assume the old generated-Pi Daimon shape.
- Explicit Daimon model selection, subagent topology, sandbox intent, and `restrict_to_workspace` are accepted or reported more strongly than they are lowered.
- Daimon evidence and readiness are not yet represented by durable, runtime-native health/export contracts.
- Parent-agent and ancestor-team resources cross inheritance boundaries prohibited by the detailed specification.
- Shared team documents enter the ordinary agent document pipeline instead of remaining namespaced team context.
- Environment substitution and publication metadata are specified but not implemented.
- Manifest path and symlink enforcement is weaker than the specification states.
- The provider-neutral target barrel exposes Docker-specific types.

## Borderline P2 — important

- `artifacts export --json` wraps the advertised versioned index in an unversioned outer object.
- `publish` can report an unknown digest while recommending a mutable tag.
- Environment identifiers, URLs, and schedule expressions are not consistently validated at the manifest boundary.
- Public Daimon still lacks a completed live end-to-end acceptance test.
- Agent homes inside one Daimon container are namespaces, not OS security boundaries; agents share a container user and filesystem trust domain.

## Carried implementation blocker

The in-progress hardened deployment-artifact publisher has one remaining borderline P2 at its loop cap: replay rejects a legitimate executable prefix created as mode `0700` before a crash, rather than safely repairing it to the intended `0755` mode.
