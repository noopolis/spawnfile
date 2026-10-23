# Shared Test Evidence

Owns deterministic observation and evaluation fixtures used across adjacent tests.
Public index.ts is for tests only; product modules must never import this folder.
Do not use these fixtures as evidence of a real native run. Keep native conformance
probes separate and require actual side effects. Test fixture behavior where guards
depend on it; include this executable source in coverage.
