# Moment Recording

- `moment.ts` owns the shared strict moment-record schema, inferred type and parser; rewind consumes the public barrel.
- `types.ts` and `compose.ts` own the portable wake-row contract and pin composition.
- `sync.ts` joins activation-scoped evidence and selects the registered reader by recorded format. Facts without a format use the released v1 wake-row format.
- `jsonl.ts` provides bounded parsing. The adapter owns the live byte transport and source format. `parse.ts` and `read.ts` preserve the historical exports.
- `history.ts` selects recording facts from the activation log; `deployment.ts` selects the live deployment and resolves feed histories.
- `store.ts` owns private, immutable moment publication and per-agent retention.
- `index.ts` is the public barrel. Tests stay beside the code.

Use activation-scoped compiled facts at started_at, never today's report for retained rows.
Select history inclusively at started_at; invalid or missing evidence makes a record non-exact.
Never fetch Moltnet messages, invoke engines, or copy snapshot trees. Daimon owns the snapshots.
Hash canonical wake-row JSON into the filename to distinguish equal-time attempts.
An existing moment file is immutable. Hold the writer lock across publication and retention;
publish via a private temporary file, fsync, rename, and directory fsync.
Recording off performs no recording I/O. Keep modules below 400 lines and use named exports.
