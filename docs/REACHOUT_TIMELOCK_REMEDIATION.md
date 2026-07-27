# Experimental BIZ_QUALITY reachout remediation

This document preserves the protocol findings and the disabled-by-default implementation for a future controlled test. It is not an automatic account-unlock mechanism and it does not change message sending, TcToken, retry receipts, Signal sessions, or interactive-message rendering.

## What the official Android client does

The WhatsApp Business Android flow is split across separate layers:

1. The account receives a reachout-timelock state from the server.
2. The remediation UI is offered only for the internal `BIZ_QUALITY` type and when Android feature flag `21412` is enabled.
3. `VideoRemediationActivity` loads a remote video URL from Android remote-config key `24562`. The APK does not contain the video.
4. After the user watches the video and confirms the action, Android submits the `RemoveAccountReachoutTimelock` MEX mutation.
5. A successful mutation response is not itself proof that the restriction disappeared; the account state must be fetched again.

Captured MEX contract:

- schema: `whatsapp_mex`
- query/document ID: `25040013452293167`
- response path: `xwa2_remove_account_reachout_timelock`
- variables:

```json
{
  "input": {
    "violation_type": "SPAM",
    "reason": "User watched remediation video",
    "reachout_timelock_type": "BIZ_QUALITY"
  }
}
```

The response shape observed in the official client is `{ "success": boolean, "error_message"?: string }`.

## Why this feature is opt-in

A Web companion does not receive Android's remote flag or video URL. Guessing either value, treating every active restriction as eligible, or marking a restriction removed only in local state would diverge from the official client and could misrepresent an account restriction.

The implementation therefore refuses the mutation unless all conditions are true:

- `experimentalReachoutTimelockRemediation.enabled === true`;
- a fresh server query reports `isActive === true`;
- `enforcementType === BIZ_QUALITY`;
- the caller confirms that Android feature flag `21412` was enabled;
- the caller supplies an HTTPS video URL obtained from Android remote-config key `24562`;
- the caller explicitly asserts that the user watched that official video.

`DEFAULT`, `WEB_COMPANION_ONLY`, `RESTRICT_ALL_COMPANIONS`, commerce-policy categories, missing data and malformed video URLs all fail closed without a mutation.

## Future controlled usage

```ts
const socket = makeWASocket({
  // normal options...
  experimentalReachoutTimelockRemediation: {
    enabled: true,
    androidFeatureFlagEnabled: true,
    officialVideoUrl: 'https://official-remote-config.example/video'
  }
})

const eligibility = await socket.getReachoutTimelockRemediationEligibility()

// The application is responsible for presenting eligibility.officialVideoUrl
// and obtaining a genuine user confirmation after playback.
if (eligibility.eligible) {
  const result = await socket.removeAccountReachoutTimelock({
    videoWatched: true,
    confirmation: 'USER_WATCHED_OFFICIAL_VIDEO'
  })
}
```

Concurrent confirmations are coalesced into one mutation. A caller-facing timeout does not release that single-flight guard: the underlying MEX request remains authoritative until it settles, preventing an immediate retry from submitting a duplicate mutation. Every attempt re-fetches eligibility before the mutation and re-fetches account state afterwards. The result is `removed` only when that final server read reports the restriction inactive. If the server accepted the mutation but the verification read fails, the result remains `server-accepted-pending-verification`; it is never reported as a failed mutation. Server rejection and transport errors are returned and logged with their concrete reason rather than replaced with a generic error.

## Deliberate non-goals

- no extraction, fabrication, redistribution, or hard-coding of the video URL;
- no automatic mutation on login, notification, error 463/479, or message send;
- no attempt to bypass `DEFAULT` reachout limits or companion restrictions;
- no local-only override of server state;
- no promise that the server will accept an otherwise well-formed request.
