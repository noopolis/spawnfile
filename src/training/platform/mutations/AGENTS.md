# Serialized host mutations

Owns an asynchronous mutation queue for durable host state. No runtime or
experiment policy belongs here. Export through index.ts. Owners must roll back failed mutations before returning; a rejected operation
does not block subsequent valid operations.
Verify ordering and failure propagation with adjacent tests.
