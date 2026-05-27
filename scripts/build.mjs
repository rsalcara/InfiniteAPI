#!/usr/bin/env node
/**
 * Build orchestrator for the baileys package.
 *
 * Runs the three build phases in order, tolerating non-fatal errors from
 * `tsc` so the chain doesn't break on harmless TS2742 (and similar
 * declaration-only) warnings.
 *
 * Why a Node script instead of an npm-script chain:
 *
 *   `package.json` scripts run under different shells across platforms:
 *   `sh -c` on macOS/Linux and `cmd.exe` on Windows. The `;` separator
 *   means "next command, regardless of exit code" in `sh` but is NOT
 *   recognised by `cmd.exe` (it gets passed through as a literal argument
 *   and breaks `tsc`'s flag parser with TS5023). The previous
 *   `tsc && tsc-esm-fix` chain conversely was too strict — any `tsc`
 *   warning that triggered exit code 1 (notably TS2742 inferred-type
 *   references to nested `node_modules/...` declarations during d.ts
 *   emission) prevented `tsc-esm-fix` from rewriting relative imports
 *   with `.js` extensions, producing a broken ESM package that fails on
 *   consumer install with `ERR_MODULE_NOT_FOUND`.
 *
 *   A Node orchestrator gives us:
 *     1. cross-platform behaviour (no shell-dependent separators);
 *     2. explicit control over which phases are fatal vs warning-only;
 *     3. a single place to evolve the build pipeline as new phases get
 *        added (e.g. wasm bundling, codegen).
 *
 * Phases:
 *   1. `tsc -P tsconfig.build.json`
 *        - emits `.js` + `.d.ts` from TypeScript sources
 *        - non-zero exit is logged as a warning, NOT a failure
 *        - the `lint` script (`tsc && eslint`) is the strict gate for
 *          real type errors, so build can be tolerant here
 *
 *   2. `tsc-esm-fix --tsconfig=tsconfig.build.json --ext=.js`
 *        - rewrites relative imports in `lib/*.js` to include the `.js`
 *          extension (required by Node's ESM resolver when
 *          `"type": "module"` is set)
 *        - MUST succeed — without this the published package is broken
 *
 *   3. `node scripts/copy-assets.mjs`
 *        - mirrors non-`.ts` assets (JSON, etc.) from `src/` to `lib/`
 *        - MUST succeed — without this `baileys-version.json` is missing
 *          from the published package and runtime imports throw
 *          `ERR_MODULE_NOT_FOUND`
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..')

/** Spawn a command, inherit stdio, resolve with the exit code. */
function run(cmd, args) {
	return new Promise(resolve => {
		const child = spawn(cmd, args, {
			stdio: 'inherit',
			shell: true, // allow `tsc` (npm bin) to resolve via PATHEXT on Windows
			cwd: REPO_ROOT
		})
		child.on('exit', code => resolve(code ?? 1))
		child.on('error', err => {
			console.error(`[build] failed to spawn ${cmd}:`, err)
			resolve(1)
		})
	})
}

async function main() {
	// Phase 1 — tsc (tolerant)
	console.log('[build] phase 1/3: tsc -P tsconfig.build.json')
	const tscCode = await run('tsc', ['-P', 'tsconfig.build.json'])
	if (tscCode !== 0) {
		console.warn(
			`[build] tsc exited with code ${tscCode} — continuing pipeline ` +
				`(the lint script is the strict type-check gate; non-fatal ` +
				`declaration warnings here do not block JS emission)`
		)
	}

	// Phase 2 — tsc-esm-fix (fatal)
	console.log('[build] phase 2/3: tsc-esm-fix (rewrite imports to add .js)')
	const fixCode = await run('tsc-esm-fix', ['--tsconfig=tsconfig.build.json', '--ext=.js'])
	if (fixCode !== 0) {
		console.error(
			`[build] tsc-esm-fix exited with code ${fixCode} — aborting. ` +
				`Without .js extensions on relative imports, the emitted ESM ` +
				`package cannot be resolved by Node's loader.`
		)
		process.exit(fixCode)
	}

	// Phase 3 — copy non-ts assets (fatal)
	console.log('[build] phase 3/3: copy-assets (mirror src/*.json → lib/)')
	const assetsCode = await run('node', ['scripts/copy-assets.mjs'])
	if (assetsCode !== 0) {
		console.error(`[build] copy-assets exited with code ${assetsCode} — aborting`)
		process.exit(assetsCode)
	}

	console.log('[build] all phases completed successfully')
}

main().catch(err => {
	console.error('[build] orchestrator crashed:', err)
	process.exit(1)
})
