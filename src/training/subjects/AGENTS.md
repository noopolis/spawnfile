# Subject services

`registry.ts` defines injected subject factories and optional hostInference grant authority. `environment.ts` owns isolated process environments; `slot-freshness.ts` and `freshness.ts` own durable experiment slot replay protection. Legacy wire discriminators are accepted through the shared alias table. Runtime implementations live outside the core.
