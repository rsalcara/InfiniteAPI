# Message sender source attribution

InfiniteAPI now exposes `message.senderSource` on `messages.upsert` messages,
writes an info-level structured log entry named
`message sender source classified`, and emits a `[BAILEYS] Sender source`
operator line with the complete author-device JID. Message content is never
included in either log.

## Evidence model

The WhatsApp Android APKs `2.26.27.83` and `2.26.31.1` persist the author
device as `message_details.author_device_jid`. Their `DeviceJid.isPrimary()`
implementation is equivalent to `device == 0`, and `UserJid.getPrimaryDevice()`
constructs device zero. This is the basis for the `primary_device` versus
`linked_device` distinction.

InfiniteAPI captures the stanza's `from`/`participant` author before
`normalizeMessageJids()` removes the device suffix. Therefore:

- `deviceId: 0` is classified as `primary_device`;
- `deviceId > 0` is classified as `linked_device`;
- `authorDeviceJid` retains the raw protocol author JID, including its device
  suffix, for audit logs and downstream consumers;
- `web` is emitted only when the current configured client is the author and
  its transport profile is `web`;
- missing/lossy author data, including bare user JIDs without an explicit device
  suffix, is `unknown`.

The protocol does not reliably disclose whether an unrelated linked device is
Chrome, Desktop, Android or another companion. The implementation deliberately
does not infer that from message IDs, browser-like strings, or device numbers.

## Limitations

This is device-level protocol attribution. It does not prove who physically
typed a message, and it is not Android hardware attestation. History-sync
messages can be `unknown` when the original device JID was not preserved.

The public field is additive and optional, so consumers that ignore it retain
the existing event shape and behavior.
