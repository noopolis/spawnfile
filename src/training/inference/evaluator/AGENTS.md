# Evaluator route admission

Owns explicit trusted evaluator grants, durable request/spend admission and
allowlisted receipts. Codex extraction/proposals and TypeSafe decisions are
separate purposes and model identities. A supplied routes file always activates
evaluator budgets, independently of the subject cap. No generic native exemption.
Admission is synchronous in the single evaluator process and fsynced before any
provider attempt; interrupted reservations remain charged on resume. Changed
route budgets refuse resume. Transport receipts never contain prompts or errors.
Secret leaves are read into TypeSafe-local environments only, never process.env.
Verify adjacent route, exhaustion, failure/resume, mutation and secret tests.
