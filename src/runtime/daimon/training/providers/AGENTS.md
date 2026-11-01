# Daimon inference providers

`codex-subscription/` owns contained Codex subscription inference for graders and evaluators in the parent process. `grok-subscription/` owns the shared native CLI transport and saved-login route. `grok-broker/` owns Daimon broker grants, model catalog, bounded pooling and private evaluator homes. Runtime provider registration enters the neutral core through descriptors.
