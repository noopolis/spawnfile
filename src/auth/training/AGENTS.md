# Training credential transactions

`writebackLock.ts` holds the same private SQLite lock for profile import and
runtime credential writeback. Keep the lock file at its existing durable
path so old and new writers serialize with each other.
