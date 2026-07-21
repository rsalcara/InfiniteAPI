# SMB_ANDROID pair-code profile

InfiniteAPI supports two isolated phone-number pairing profiles:

- `smb_android` (default for fresh credentials): announces
  `ClientPayload.UserAgent.SMB_ANDROID`, omits `WebInfo`, registers
  `DeviceProps.ANDROID_PHONE`, and sends Android phone platform code `e` with
  an empty binary pairing nonce.
- `web`: preserves the established WhatsApp Web registration and pair-code
  wire values, including the browser platform code and nonce `0`.

## Environment selection

Fresh sessions use `smb_android` when neither variable is set. To select the
stable Web fallback requested for compatibility:

```dotenv
PAIR_CODE=true
```

The explicit form is preferred in new deployments:

```dotenv
PAIR_CODE_PROFILE=web
```

Accepted explicit values are `web` and `smb_android`. `PAIR_CODE_PROFILE`
takes precedence over the compatibility `PAIR_CODE` switch.

## Session isolation

The chosen profile is persisted in `AuthenticationCreds`; therefore the same
contract works with multi-file (legacy), monolithic SQLite, and multi-bank
SQLite auth state. Credentials created before the marker existed are inferred
as Web credentials.

A session cannot change profile in place. If the configured profile differs
from the stored one, socket construction fails with an actionable mismatch
error. Create a fresh session to test another profile; automatic cross-profile
fallback would mix registration identities and is intentionally forbidden.

## Device metadata

Device metadata is not configured through environment variables. On the first
SMB_ANDROID registration, InfiniteAPI randomly selects one entry from its
validated built-in catalog and persists a complete snapshot alongside stable
`phoneId` and `deviceExpId` values. Reconnects, process/container restarts and
server restarts reuse the snapshot; only a genuinely new auth state selects a
new profile.

The catalog rejects empty, incomplete, duplicate, unverified, malformed or
Android/build-incoherent entries. The following 21 launch-generation profiles
are eligible:

| Generation | Models | Android | Base Build.ID |
| --- | --- | --- | --- |
| Galaxy S26 | SM-S948B, SM-S947B, SM-S942B | 16 | BP2A.250605.031.A3 |
| Galaxy S25 | SM-S938B, SM-S936B, SM-S931B | 15 | AP3A.240905.015.A2 |
| Galaxy S24 | SM-S928B, SM-S926B, SM-S921B | 14 | UP1A.231005.007 |
| Galaxy S23 | SM-S918B, SM-S916B, SM-S911B | 13 | TP1A.220624.014 |
| Galaxy S22 | SM-S908B, SM-S906B, SM-S901B | 12 | SP1A.210812.016 |
| Galaxy S21 | SM-G998B, SM-G996B, SM-G991B | 11 | RP1A.200720.012 |
| Galaxy S20 | SM-G988B, SM-G985F, SM-G980F | 10 | QP1A.190711.020 |

The submitted S26+ and S26 codes were corrected from `SM-S946B`/`SM-S941B`
to Samsung's documented `SM-S947B`/`SM-S942B`. The inferred `VP1A` and `WP1A`
builds were not used; Android 15/16 use the documented AP3A/BP2A base families.
Model and launch-version evidence comes from Samsung product/support material;
base Build.ID coherence is checked against Android's published build mapping
and observed Samsung device/test records.

These values identify the virtual companion presented by InfiniteAPI. They are
not claimed to be captured from the primary phone.

The server-provided `pair-success` fields are stored separately as
`pairSuccessMetadata`: platform, assigned device JID/LID, Business name,
account type, ADV device type, and key index. The protocol does not provide the
primary phone's manufacturer/model in that response, so the library does not
fabricate them.

## Scope

This profile implements the verified SMB_ANDROID ClientPayload, DeviceProps,
and link-code application-layer wire differences while retaining the existing
InfiniteAPI socket transport. It does not claim to reproduce the official
application's native MNS networking runtime. Keep the Web fallback available
while the SMB_ANDROID profile is validated against real accounts.
