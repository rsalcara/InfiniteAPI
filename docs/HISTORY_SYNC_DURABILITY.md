# Durable History Sync

InfiniteAPI keeps WhatsApp history synchronization separate from live message processing. A history notification is admitted to a durable queue first; download, decode, relational persistence, retry, and reupload then run in a background worker.

This design applies to the three built-in authentication backends and does not change the public message sending API or the existing history events.

## Supported backends

| Auth backend | Durable queue storage |
| --- | --- |
| `multifile` | `history-sync-state.json` in the session directory, written with temporary and backup files |
| `sqlite` | `history_sync_jobs` and `history_sync_checkpoints` in the monolithic `auth.db` |
| `multidb-sqlite` | `history_sync_jobs` and `history_sync_checkpoints` in `sync.db` |

The queue is part of the authentication state but does not couple the selected transport profile to a storage backend.

Custom `AuthenticationState` implementations may expose the optional `historySync` capability. Implementations without it continue to use the synchronous compatibility path.

## Job lifecycle

Each notification is keyed by its original message ID and moves through these states:

```text
received -> downloading -> decoded -> applying -> committed
                         \-> failed -> downloading
                         \-> reupload_pending -> received
```

- `received`: the notification is durable and eligible for the worker.
- `downloading`: the worker owns a time-limited lease for the chunk.
- `decoded`: download, decryption, decompression, and protobuf decoding succeeded.
- `applying`: mandatory local message and LID mapping writes are running.
- `committed`: mandatory writes and the phase checkpoint committed.
- `failed`: a local or recoverable failure has an exponential retry time with jitter.
- `reupload_pending`: the payload is missing or corrupt and the phone has been asked to upload it again.

A reupload uses the official peer receipt shape: `type="server-error"`, `category="peer"`, encrypted `enc_p` and `enc_iv`, and no normal-media `rmr` node.

## Ordering and checkpoints

Chunks use the same priority as WhatsApp Web: higher protocol sync types are considered first, while chunk order is ascending within a type. Explicit barriers prevent `RECENT` from passing an unfinished `INITIAL_BOOTSTRAP` and prevent `FULL` from passing unfinished `RECENT` work.

Sessions created before durable checkpoints existed use their persisted `processedHistoryMessages` only as a one-time compatibility baseline. New sessions require the preceding checkpoint and cannot skip a missing chunk.

Successful chunks advance monotonic checkpoints for:

```text
INITIAL
RECENT
FULL
```

The job state and its checkpoint commit in one SQLite transaction. The multifile backend performs the equivalent state update through an atomic file replacement, flushes the temporary file before rename, flushes the containing directory where the operating system supports it, and rolls its in-memory state back if the disk write fails.

Expired `downloading`, `decoded`, or `applying` leases are reclaimed after a restart. Retained commits reconcile their idempotent credentials callback on reconnect, covering a crash between checkpoint commit, event delivery, and an external `saveCreds` call. A persistent post-commit marker prevents repeating a successful callback on later reconnects. Recovered commits never mark the current connection's `INITIAL`, `RECENT`, or `FULL` stream complete; only chunks processed by that connection may update its live completion flags. Committed diagnostic rows are retained for seven days; pending work is never deleted during socket teardown.

`migrateAuthState` copies jobs, checkpoints, post-commit markers, and compatibility metadata when both source and destination expose durable history storage. It rejects a migration to a destination without that capability when the source contains durable history state. Clearing auth keys for logout, re-pair, or key rotation also clears the durable history state; the multifile backend removes the primary, temporary, and backup queue files so an old session cannot be recovered into a new identity.

## Live message isolation

History download and apply do not run in the live-message admission path. The worker:

- processes at most eight chunks per event-loop turn;
- yields between chunks and between relational write batches;
- adapts relational batches between 1 and 500 records using measured write latency;
- keeps retries on timers instead of waiting in a socket callback;
- aborts an active download and stops local apply between bounded writes during teardown;
- limits worker drain to two seconds, leaving the durable lease recoverable after reconnect.

This prevents slow history media, a large history payload, or a retry delay from holding live message ACKs, sends, keepalive frames, or reconnection.

## Events and delivery semantics

Existing events and payloads remain unchanged:

```ts
sock.ev.on('messaging-history.set', history => {
    // Upsert by the existing message keys.
})

sock.ev.on('messaging-history.status', status => {
    // status: "complete" is emitted only after the durable checkpoint commits.
})
```

`messaging-history.set` is delivered with **at-least-once** semantics after mandatory local apply. If the process stops or the checkpoint write fails at the final boundary, recovery can emit the same chunk again with the same message keys. Consumers should use idempotent upserts rather than append-only inserts.

`messaging-history.status` with `status: "complete"` is emitted only after the corresponding `INITIAL`, `RECENT`, or `FULL` checkpoint is durable. A received notification or the timeout that releases live events does not falsely mark history as complete.

## Failure behavior

- Network and CDN failures retry with exponential backoff and jitter without being converted into a reupload merely because they have failed many times.
- Corrupt, undecryptable, missing, HTTP 404, or HTTP 410 payloads request reupload from the phone.
- Failures after a successful download are local failures and never request a remote reupload.
- A partial mandatory persistence failure prevents checkpoint advancement and is retried idempotently.
- A socket close rejects new worker writes, aborts the active download, and marks admitted work retryable within the bounded teardown deadline; a later socket resumes it from durable state or an expired lease.
