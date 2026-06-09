/**
 * Ambient declarations for the OPTIONAL peer dependencies that the VoIP
 * stack lazy-loads via `import('...')` at runtime. Both `@roamhq/wrtc` and
 * `qrcode-terminal` are declared in `package.json` under
 * `peerDependenciesMeta.*.optional = true` — they don't ship with the lib
 * itself; only consumers that actually place calls install them.
 *
 * Without these declarations, `tsc` would refuse the lazy `import()` calls
 * in `index.ts` / `relay-transport.ts` because it can't resolve the type
 * shape. We don't need accurate types here — the call sites cast through
 * `any` immediately — so a minimal `Record<string, any>` is enough to
 * satisfy the resolver.
 *
 * If a consumer needs strongly-typed access to either lib, they can install
 * `@types/qrcode-terminal` and `@roamhq/wrtc`'s own `.d.ts` (it ships its
 * own types); those win over these ambient stubs via TypeScript's normal
 * module resolution (real `.d.ts` in `node_modules` beats ambient).
 */
declare module 'qrcode-terminal' {
	const QRCodeTerminal: Record<string, unknown> & {
		generate(text: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void
	}
	export default QRCodeTerminal
	export const generate: QRCodeTerminal['generate']
}

declare module '@roamhq/wrtc' {
	const wrtc: Record<string, unknown> & {
		RTCPeerConnection: new (config?: unknown) => unknown
	}
	export default wrtc
	export const RTCPeerConnection: new (config?: unknown) => unknown
}
