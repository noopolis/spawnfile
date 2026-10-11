# Training Rewind

- `contract.ts` owns strict moment, materialization, leak and task-clock documents and generated schemas.
- `history.ts` is the only boundary for reading history files, logs and retained bytes; every path must be lexically and physically contained.
- `select.ts` and `inputs.ts` resolve records, examples and effective inputs without I/O.
- `types.ts` defines input identities, declarations and per-kind contexts/results; `index.ts` exports the public materializer and pure selection/cut helpers.
- `git.ts` owns resources; `gitProcess.ts`, `gitHistory.ts`, `gitTree.ts`, and `gitArchive.ts` isolate argv execution, containment, blob trees, and feed archives.
- `feed.ts`, `memory.ts`, and `volumes.ts` own their cuts and history-log schemas; `memorySchemas.ts` validates native ledger events.
- `moltnet.ts` dispatches stores; `moltnetJson.ts`, `moltnetSqlite.ts`, `moltnetSqliteData.ts`, and `moltnetSchemas.ts` own snapshots, copied databases, SQL decoding, and strict native shapes.
- `materialize.ts` stages all inputs and publishes only after the independent disk reader in `leakCheck.ts` accepts them.
- `leakFiles.ts`, `leakGit.ts`, and `leakInputs.ts` inspect disk metadata, every git object, and native payloads independently of materialization decisions.
- `instant.ts` compares parsed nanosecond instants; `timestamps.ts` stamps metadata without following symlinks.
- `taskClock.ts` defines offset wall-clock environment only; timeouts remain real. libfaketime requires trial-owned LD_PRELOAD.
- Adjacent tests use local temporary repositories and fixtures. Never use Docker, production hosts or network fetches.
- `fixtures.test-helper.ts` and `git.test-helper.ts` build disposable real projects and repositories; package emission excludes them.
- Selector-at git history is approximate: committer dates cannot prove when a commit reached a ref. Feed-rule approximation cannot reconstruct freeze holds.
- Reuse P2 effective input identity resolution. No input may silently use present-day data.
- Mneme's root API validates the cut through a temporary rebuilt index, which is discarded: output contains neither derived indexes nor authority/audit state. Missing optional Mneme support refuses explicitly.
- Generated inputs spanning repositories refuse: this history contract carries one commit per resource. Never claim that one repository proves another repository's bytes.
- Keep modules under 400 lines, use named/barrel exports, and never import Mneme internals.
