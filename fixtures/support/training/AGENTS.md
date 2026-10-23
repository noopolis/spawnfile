# Training test fixtures

Synthetic CLI, viewer, context and grader fixtures retain historical provider wire data outside the runtime-neutral core. Keep fixture bodies stable when moving them; production training must never import this folder. Tests may compose the runtime registries here.
