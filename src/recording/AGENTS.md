# Moment Recording

- `types.ts`, `parse.ts`, and `compose.ts` own the pure wake-row contract and pin composition.
- `sync.ts` reads deployed wake rows and Mneme ledgers through the same exec transport as usage.
- `deployment.ts` binds compiled recording facts to the selected live deployment and resolves feed histories.
- `store.ts` owns private, immutable moment publication and per-agent retention.
- `index.ts` is the public barrel. Tests stay beside the code.

Use deployed compiled facts, never recompile current authoring files or infer pins from live state.
Select history inclusively at started_at; invalid or missing evidence makes a record non-exact.
Never fetch Moltnet messages, invoke engines, or copy snapshot trees. Daimon owns the snapshots.
An existing moment file is immutable. Hold the writer lock across publication and retention;
publish via a private temporary file, fsync, rename, and directory fsync.
Recording off performs no recording I/O. Keep modules below 400 lines and use named exports.
