# Native experiment services

`slot-freshness.ts` owns durable, locked replay protection for broker subject slots; `freshness.ts` places it in the experiment state directory. Composition creates one store and hands the same capability to preparation and execution. Preserve the existing filename, schema and generation floors across resumes.
