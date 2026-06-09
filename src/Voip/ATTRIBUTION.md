# VoIP module — attribution and license

The `src/Voip/` directory is a port of
[**SheIITear/baileys-caller**](https://github.com/SheIITear/baileys-caller)
(commit referenced in this PR's commit message) by ShellTear, used under the
MIT License.

## Original license

```
MIT License

Copyright (c) 2025 ShellTear

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Adaptations for the fork

  * `.mts` extensions renamed to `.ts` to fit the rest of the codebase.
  * Internal relative imports rewritten from `.mjs` to `.js` so the
    `tsc-esm-fix` post-pass rewrites them on emit.
  * The original lazy-load of `@whiskeysockets/baileys` (`await import(...)`)
    was replaced with direct imports from the fork's own
    `src/Socket/index.ts`, `src/Utils/use-multi-file-auth-state.ts`, and
    `src/Types/index.ts`. The peer-dep ceremony is unnecessary when the
    consumer of the VoIP module IS the fork itself.
  * `@roamhq/wrtc` and `qrcode-terminal` declared as optional peer
    dependencies (`peerDependenciesMeta.*.optional = true`) so the published
    package doesn't force-install ~50MB of native WebRTC bindings on users
    who never place a call. Ambient `.d.ts` declarations in
    `voip-optional-peers.d.ts` keep `tsc` happy when the libs are absent
    during compilation.
  * The `whatsapp.wasm` / `loader.js` / `worker-modules.js` blobs in
    `assets/wasm/` were copied verbatim from the SheIITear repo. Those
    artifacts originate from WhatsApp Web's official VoIP module — they are
    Meta-authored binaries; the SheIITear MIT license covers only the
    surrounding glue code, not the WASM binary itself.

The original code structure and architectural decisions (the 5-module split
WasmEngine / RelayRtcTransport / SignalingBridge / AudioFeeder + worker
bootstrap; the `VoipClient` / `ActiveCall` public API; the HKDF + HMAC
crypto helpers) are preserved.
