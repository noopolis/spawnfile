# Calibration before training

Owns the train command's calibration step. `calibration.ts` reads the authored `training.calibration` sets
beside the frozen train dataset, binds each to the questionnaire check it names and judges it on the run's
judge routes before the first trial, through the registered check (`regradeRecordedOutputs`).

- A set's bank must be the bank the train dataset froze; a changed bank is refused.
- Results are kept one file per output under `<out>/calibration/<set>-<digest>`. The digest binds the bank,
  the set and every file it names: an unchanged output is never asked again, a changed one always is.
- A set the bank misses throws the refusal before any trial. Nothing is retried into a pass.
- Every judge call, a restored one included, is reported through `calibration.judged` for cost accounting.
- Tests live beside source; keep the 90% coverage floor and files under 400 lines.
