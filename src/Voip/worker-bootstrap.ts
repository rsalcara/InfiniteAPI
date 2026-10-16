/**
 * Worker-thread bootstrap for the WhatsApp WASM VoIP engine.
 *
 * Mirrors the browser Web-Worker environment (self/postMessage/babelHelpers/
 * MessagePort) the WASM loader expects, then runs that loader inside a Node
 * `worker_threads` Worker. Function-keyword shims are intentional — the
 * loader inspects `.prototype` and `instanceof` on these.
 *
 */
'use strict'

import * as crypto from 'crypto'
import * as fs from 'fs'
import { createRequire } from 'module'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import * as vm from 'vm'
import { parentPort, type TransferListItem, workerData } from 'worker_threads'

// NOTE: tsc-esm-fix runs a global `replace(/_wbFilename/g, ...)` and
// `replace(/_wbDirname/g, ...)` on the compiled .js, intending to translate
// CommonJS magic into ESM equivalents. The replacement target is a template
// literal that, when substituted on the LEFT-HAND SIDE of `const X = ...`,
// produces unparseable JS — Workers spawn but fail silently with "0 ready
// workers" timing out after 15s. Pick non-magic names to dodge the rewrite,
// and wrap `import.meta.url` in `new URL(...)` so the matching pattern
// `X = fileURLToPath(import.meta.url)` never appears in the output either.
const _wbDirname = fileURLToPath(new URL('.', import.meta.url))
const _wbFilename = fileURLToPath(new URL(import.meta.url))
const _require = createRequire(import.meta.url)

interface WorkerData {
	wasmPath?: string
	wasmBinary?: Uint8Array
	workerModulesCode?: string
	loaderCode?: string
	loaderModuleName?: string
	resourcesPath?: string
	enableLogs?: boolean
}

// Reserved for future use — the WA Web worker bundle emits messages in this
// shape, but our current dispatcher reads fields ad-hoc rather than typing
// the whole payload. Kept here as a reference for downstream typing work.
interface _WasmCallbackPayload {
	type: string
	__name?: string
	[key: string]: unknown
}

const typedWorkerData = workerData as WorkerData | undefined

// ---------------------------------------------------------------------------
// Local typings. They describe only the fields this bootstrap touches on the
// shimmed worker global, the `__d`/`__r` module registry, the emscripten
// `Module` object and the messages exchanged with the host thread.
// ---------------------------------------------------------------------------

/** Minimal `process` stand-in installed when the worker has no Node `process`. */
interface ProcessShim {
	cwd: () => string
	env: Record<string, string | undefined>
	platform: string
	version: string
	versions: Record<string, string>
	nextTick: (fn: Function, ...args: unknown[]) => unknown
	exit: (code: number) => void
	on: () => void
	off: () => void
	once: () => void
	emit: () => void
}

/** Babel runtime helpers installed on `global.babelHelpers`. */
interface BabelHelpers {
	assertThisInitialized: (self: unknown) => unknown
	[helper: string]: unknown
}

/** A constructor function whose legacy `__proto__` slot may be written. */
type ClassLike = Function & { __proto__?: unknown }

/** Any value whose legacy `__proto__` accessor may be read or written. */
interface WithProto {
	__proto__?: unknown
}

/** Entry of the `protoProps`/`staticProps` arrays given to `createClass`. */
interface ClassPropertyDescriptor extends PropertyDescriptor {
	key: PropertyKey
}

/** Template strings array as seen by `taggedTemplateLiteralLoose`. */
type TemplateStrings = string[] & { raw?: readonly string[] }

/** Whatever a `__d` factory left on `module.exports`, viewed as a namespace. */
interface ModuleNamespace {
	__esModule?: boolean
	default?: unknown
	[key: string]: unknown
}

type ModuleExports = ModuleNamespace | null | undefined

interface ModuleFactoryEntry {
	factory: Function | undefined
	deps: string[]
	flags?: unknown
}

type WhatsAppVoipWasmWorkerCompatibleCallbacks = Record<string, (...args: any[]) => unknown>

/**
 * Message posted to this worker by the host thread. Routing keys on
 * `type`/`cmd`; every other field depends on the command, so anything not
 * listed here stays `unknown`.
 */
interface WorkerMessage {
	type?: string
	cmd?: string
	target?: string
	/** `cmd: 'load'` */
	wasmModule?: WebAssembly.Module
	wasmMemory?: WebAssembly.Memory
	workerID?: number
	handlers?: string[]
	/** `cmd: 'run'` */
	pthread_ptr?: number
	start_routine?: number
	arg?: number
	/** `type: 'jsWorkerCmd'` */
	jsWorkerCmd?: string
	/** `type: 'waWasmWorkerCompatibleCallback'` */
	__name?: string
	[key: string]: unknown
}

type WorkerMessageEventHandler = (event: { data: unknown }) => void

/** Shape read off a thrown value / rejection reason. */
interface ErrorLike {
	name?: unknown
	message?: unknown
	stack?: unknown
}

interface UnhandledRejectionLike {
	reason?: unknown
}

/** `onVideoDataFromJs` / `onDesktopCaptureDataFromJs` embind entry points. */
type VideoFrameSender = (...args: number[]) => void

/** Subset of the emscripten `Module` object the pthread worker drives. */
interface VoipEmscriptenModule {
	wasmModule?: WebAssembly.Module | null
	wasmMemory?: WebAssembly.Memory
	buffer?: ArrayBuffer
	workerID?: number
	ENVIRONMENT_IS_PTHREAD?: boolean
	WhatsAppVoipWasmWorkerCompatibleCallbacks?: WhatsAppVoipWasmWorkerCompatibleCallbacks
	instantiateWasm?: (
		imports: WebAssembly.Imports,
		successCallback: (instance: WebAssembly.Instance) => unknown
	) => unknown
	PThread?: {
		receiveObjectTransfer: (data: WorkerMessage) => void
		threadInitTLS: () => void
	}
	_pthread_self?: () => number
	_malloc?: (size: number) => number
	_free?: (ptr: number) => void
	GROWABLE_HEAP_U8?: () => Uint8Array
	onVideoDataFromJs?: VideoFrameSender
	onDesktopCaptureDataFromJs?: VideoFrameSender
	establishStackSpace?: () => void
	invokeEntryPoint?: (startRoutine: number | undefined, arg: number | undefined) => void
	checkMailbox?: () => void
	__emscripten_thread_init?: (
		pthreadPtr: number,
		isMainBrowserThread: number,
		isMainRuntimeThread: number,
		canBlock: number
	) => void
	__emscripten_thread_mailbox_await?: (pthreadPtr: number) => void
	__emscripten_thread_exit?: (status: number) => void
	__emscripten_thread_crashed?: () => void
	__embind_initialize_bindings?: () => void
	/** Host handlers proxied by name (see `h()` in the `load` command). */
	[key: string]: unknown
}

/** The worker's global object as the WA Web loader expects to see it. */
interface WorkerGlobal {
	process?: NodeJS.Process | ProcessShim
	require?: NodeJS.Require
	babelHelpers: BabelHelpers
	__d: (name: string, deps: string[] | Function, factory?: Function, flags?: unknown) => void
	__r: (name: string) => ModuleExports
	importScripts: (...urls: string[]) => void
	postMessage: (data: unknown, transfer?: readonly TransferListItem[]) => void
	addEventListener: (type: string, handler: WorkerMessageEventHandler) => void
	self: WorkerGlobal
	window?: unknown
	location?: unknown
	alert?: (...args: unknown[]) => void
	onunhandledrejection?: (event: UnhandledRejectionLike) => void
	startWorker?: (module: VoipEmscriptenModule) => void
	__waModule?: VoipEmscriptenModule
	WhatsAppVoipWasmWorkerCompatibleCallbacks?: WhatsAppVoipWasmWorkerCompatibleCallbacks
}

/** Payloads the WASM side hands to `WhatsAppVoipWasmWorkerCompatibleCallbacks`. */
interface SignalingXmppArgs {
	peerJid: unknown
	callId: unknown
	xmlPayload: unknown
}

interface CallEventArgs {
	eventType: unknown
	userData: unknown
	eventDataJson: unknown
}

interface RelayPacketArgs {
	data?: { length?: number; byteLength?: number } | null
	len?: number
	ip?: unknown
	port?: unknown
}

/** Callbacks whose payload is forwarded verbatim to the host thread. */
type ForwardedCallbackArgs = Record<string, unknown>

interface VideoFrameArgs {
	userJid: unknown
	frameBuffer: ArrayBuffer
	width: unknown
	height: unknown
	orientation: unknown
	format: unknown
	timestamp: unknown
	isKeyFrame: unknown
}

type ByteSource = ArrayLike<number> | ArrayBuffer

/** Inputs `WABinary.Binary.build` knows how to turn into bytes. */
type BinaryInput = string | ArrayLike<number> | ArrayBuffer | ArrayBufferView | null | undefined

interface HkdfArgs {
	key_: ByteSource
	salt_?: ByteSource | null
	info_: BinaryInput
	length: number
}

interface HmacArgs {
	data_: ByteSource
	key_: ByteSource
}

/** Stub for the WA Web `bx` resource-id helper module. */
interface BxModule {
	(id: unknown): unknown
	getURL?: (id: unknown, opts?: unknown) => string
}

interface JsWorkerMessageHandlerModule {
	handleJsWorkerMessage: Function
}

declare const global: WorkerGlobal

if (typeof process === 'undefined') {
	global.process = {
		cwd: () => _wbDirname || '.',
		env: {},
		platform: 'linux',
		version: 'v18.0.0',
		versions: {},
		nextTick: (fn: Function, ...args: unknown[]) => setImmediate(fn as (...args: unknown[]) => void, ...args),
		exit: (code: number) => {
			throw new Error(`Process exit: ${code}`)
		},
		on: () => {},
		off: () => {},
		once: () => {},
		emit: () => {}
	}
} else if (!(process as { cwd?: () => string }).cwd) {
	;(process as { cwd?: () => string }).cwd = () => _wbDirname || '.'
}

global.babelHelpers = {
	extends: function (target: Record<string, unknown>) {
		for (var i = 1; i < arguments.length; i++) {
			var source = arguments[i]
			if (source != null) {
				for (var key in source) {
					if (Object.prototype.hasOwnProperty.call(source, key)) {
						target[key] = source[key]
					}
				}
			}
		}

		return target
	},

	inheritsLoose: function (subClass: ClassLike, superClass: Function) {
		subClass.prototype = Object.create(superClass.prototype)
		subClass.prototype.constructor = subClass
		subClass.__proto__ = superClass
	},

	taggedTemplateLiteralLoose: function (strings: TemplateStrings, raw?: readonly string[]) {
		if (!raw) raw = strings.slice(0)
		strings.raw = raw
		return strings
	},

	asyncToGenerator: function (fn: Function) {
		return function (this: unknown) {
			var self = this
			var args = arguments
			return new Promise(function (resolve, reject) {
				var gen = fn.apply(self, args)
				function step(key: string, arg?: unknown) {
					try {
						var info = gen[key](arg)
						var value = info.value
					} catch (error) {
						reject(error)
						return
					}

					if (info.done) {
						resolve(value)
					} else {
						Promise.resolve(value).then(
							function (val: unknown) {
								step('next', val)
							},
							function (err: unknown) {
								step('throw', err)
							}
						)
					}
				}

				step('next')
			})
		}
	},

	createClass: function (
		Constructor: Function,
		protoProps?: ClassPropertyDescriptor[],
		staticProps?: ClassPropertyDescriptor[]
	) {
		if (protoProps) {
			for (var i = 0; i < protoProps.length; i++) {
				var descriptor: ClassPropertyDescriptor = protoProps[i]!
				descriptor.enumerable = descriptor.enumerable || false
				descriptor.configurable = true
				if ('value' in descriptor) descriptor.writable = true
				Object.defineProperty(Constructor.prototype, descriptor.key, descriptor)
			}
		}

		if (staticProps) {
			for (var j = 0; j < staticProps.length; j++) {
				var staticDescriptor: ClassPropertyDescriptor = staticProps[j]!
				staticDescriptor.enumerable = staticDescriptor.enumerable || false
				staticDescriptor.configurable = true
				if ('value' in staticDescriptor) staticDescriptor.writable = true
				Object.defineProperty(Constructor, staticDescriptor.key, staticDescriptor)
			}
		}

		return Constructor
	},

	classCallCheck: function (instance: unknown, Constructor: Function) {
		if (!(instance instanceof Constructor)) {
			throw new TypeError('Cannot call a class as a function')
		}
	},

	defineProperty: function (obj: Record<string, unknown>, key: string, value: unknown) {
		if (key in obj) {
			Object.defineProperty(obj, key, {
				value: value,
				enumerable: true,
				configurable: true,
				writable: true
			})
		} else {
			obj[key] = value
		}

		return obj
	},

	objectSpread: function (target: Record<PropertyKey, unknown>) {
		for (var i = 1; i < arguments.length; i++) {
			var source = arguments[i] != null ? arguments[i] : {}
			var ownKeys: PropertyKey[] = Object.keys(source)
			if (typeof Object.getOwnPropertySymbols === 'function') {
				ownKeys = ownKeys.concat(
					Object.getOwnPropertySymbols(source).filter(function (sym) {
						return Object.getOwnPropertyDescriptor(source, sym)!.enumerable
					})
				)
			}

			ownKeys.forEach(function (key: PropertyKey) {
				target[key] = source[key]
			})
		}

		return target
	},

	objectSpread2: function (target: Record<string, unknown>) {
		for (var i = 1; i < arguments.length; i++) {
			var source = arguments[i] != null ? arguments[i] : {}
			if (i % 2) {
				Object.keys(source).forEach(function (key) {
					target[key] = source[key]
				})
			} else if (Object.getOwnPropertyDescriptors) {
				Object.defineProperties(target, Object.getOwnPropertyDescriptors(source))
			} else {
				Object.keys(source).forEach(function (key) {
					Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)!)
				})
			}
		}

		return target
	},

	wrapNativeSuper: function (Class: Function) {
		var _cache: Map<unknown, unknown> | undefined = typeof Map === 'function' ? new Map() : undefined

		function Wrapper(this: unknown) {
			return _construct(Class, arguments, _getPrototypeOf(this).constructor)
		}

		function _construct(Parent: Function, args: ArrayLike<unknown>, Class: Function | undefined) {
			if (typeof Reflect !== 'undefined' && Reflect.construct) {
				return Reflect.construct(Parent, args, Class)
			}

			var a: unknown[] = [null]
			a.push.apply(a, args as unknown[])
			var instance = new ((Function.bind as Function).apply(Parent, a) as new () => object)()
			if (Class) Object.setPrototypeOf(instance, Class.prototype)
			return instance
		}

		function _getPrototypeOf(_o: unknown) {
			return (
				Object.getPrototypeOf ||
				function (o: WithProto) {
					return o.__proto__
				}
			)
		}

		if (typeof Class !== 'function') return Class

		if (_cache) {
			if (_cache.has(Class)) return _cache.get(Class)
			_cache.set(Class, Wrapper)
		}

		Wrapper.prototype = Object.create(Class.prototype, {
			constructor: { value: Wrapper, enumerable: false, writable: true, configurable: true }
		})

		return Object.setPrototypeOf(Wrapper, Class)
	},

	isNativeFunction: function (fn: Function) {
		return Function.toString.call(fn).indexOf('[native code]') !== -1
	},

	getPrototypeOf: function (o: WithProto) {
		return Object.getPrototypeOf ? Object.getPrototypeOf(o) : o.__proto__
	},

	setPrototypeOf: function (o: WithProto, p: object | null) {
		return Object.setPrototypeOf ? Object.setPrototypeOf(o, p) : ((o.__proto__ = p), o)
	},

	assertThisInitialized: function (self: unknown) {
		if (self === void 0) {
			throw new ReferenceError("this hasn't been initialised - super() hasn't been called")
		}

		return self
	},

	possibleConstructorReturn: function (self: unknown, call: unknown) {
		if (call && (typeof call === 'object' || typeof call === 'function')) return call
		return global.babelHelpers.assertThisInitialized(self)
	},

	inherits: function (subClass: Function, superClass: Function | null) {
		if (typeof superClass !== 'function' && superClass !== null) {
			throw new TypeError('Super expression must either be null or a function')
		}

		subClass.prototype = Object.create(superClass?.prototype, {
			constructor: { value: subClass, writable: true, configurable: true }
		})
		if (superClass) Object.setPrototypeOf(subClass, superClass)
	},

	construct: function (Parent: Function, args: ArrayLike<unknown>, Class?: Function) {
		if (typeof Reflect !== 'undefined' && Reflect.construct) {
			return Reflect.construct(Parent, args, Class)
		}

		var a: unknown[] = [null]
		a.push.apply(a, args as unknown[])
		var Constructor = (Function.bind as Function).apply(Parent, a) as new () => object
		var instance = new Constructor()
		if (Class) Object.setPrototypeOf(instance, Class.prototype)
		return instance
	},

	isNativeReflectConstruct: function () {
		if (typeof Reflect === 'undefined' || !Reflect.construct) return false
		try {
			Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {}))
			return true
		} catch (e) {
			return false
		}
	}
}

if (typeof global.require === 'undefined') {
	global.require = _require
}

const _originalProcess = global.process
const _originalRequire = global.require

const hideNodeEnv = (): void => {
	try {
		delete global.process
	} catch (e) {
		global.process = undefined
	}

	try {
		delete global.require
	} catch (e) {
		global.require = undefined
	}
}

// Mirror of `hideNodeEnv`. Kept around for parity with the WA Web bundle —
// the loader currently never calls it because the worker process exits
// when the host detaches. Prefixed with `_` so eslint doesn't flag.
const _restoreNodeEnv = (): void => {
	global.process = _originalProcess
	global.require = _originalRequire
}

const __modules: Record<string, { exports: unknown }> = {}
const __moduleFactories: Record<string, ModuleFactoryEntry> = {}

global.__d = function (name: string, deps: string[] | Function, factory?: Function, flags?: unknown): void {
	if (typeof deps === 'function') {
		factory = deps
		deps = []
	}

	__moduleFactories[name] = { factory, deps, flags }
}

const importDefaultModule = (name: string): unknown => {
	const value = global.__r(name)
	return value?.__esModule ? value.default : value
}

const importAllModule = (name: string): unknown => {
	const value = global.__r(name)
	if (value == null) {
		return { default: value }
	}

	if (value.__esModule) {
		return value
	}

	if (typeof value !== 'object' && typeof value !== 'function') {
		return { default: value }
	}

	const namespace: Record<string, unknown> = {}
	for (const key of Object.keys(value)) {
		namespace[key] = value[key]
	}

	namespace.default = value
	return namespace
}

global.__r = function (name: string): ModuleExports {
	if (__modules[name]) return __modules[name].exports as ModuleExports

	const moduleFactory = __moduleFactories[name]
	if (!moduleFactory) throw new Error(`Module "${name}" not found`)

	const module: { exports: unknown } = { exports: {} }
	__modules[name] = module

	try {
		moduleFactory.factory!(global, global.__r, importDefaultModule, importAllModule, null, module, module.exports)
	} catch (e) {
		delete __modules[name]
		throw e
	}

	return module.exports as ModuleExports
}

__modules['Promise'] = { exports: Promise }

const bxFunc = function (id: unknown) {
	return id
} as BxModule
bxFunc.getURL = function (_id: unknown, _opts?: unknown) {
	return ''
}

__modules['bx'] = { exports: bxFunc }
__modules['WorkerBundleResource'] = {
	exports: {
		createDedicatedWebWorker: function () {
			return null
		}
	}
}
__modules['WorkerClient'] = { exports: { init: function () {} } }
__modules['WorkerMessagePort'] = {
	exports: { WorkerSyncedMessagePort: function () {} }
}
__modules['WAWebVoipWebWasmWorkerResource'] = { exports: {} }

if (typeof self === 'undefined') global.self = global
global.self = global
if (typeof global.window === 'undefined') global.window = global

global.importScripts = function (...urls: string[]): void {
	for (const url of urls) {
		try {
			const code = fs.readFileSync(url, 'utf8')
			eval(code)
		} catch (e) {}
	}
}

if (typeof global.location === 'undefined') {
	global.location = {
		href: _wbFilename,
		origin: 'file://',
		protocol: 'file:',
		host: '',
		hostname: '',
		port: '',
		pathname: _wbFilename,
		search: '',
		hash: ''
	}
}

global.postMessage = function (data: unknown, transfer?: readonly TransferListItem[]): void {
	if (parentPort) parentPort.postMessage(data, transfer)
}

const messageListeners: Array<WorkerMessageEventHandler> = []
global.addEventListener = function (type: string, handler: WorkerMessageEventHandler): void {
	if (type === 'message') {
		messageListeners.push(handler)
		if (parentPort)
			parentPort.on('message', (data: unknown) => {
				handler({ data })
			})
	}
}

class SimpleHook<T = unknown> {
	private listeners: Array<(data: T) => void> = []
	add = (fn: (data: T) => void): ((data: T) => void) => {
		this.listeners.push(fn)
		return fn
	}
	remove = (fn: (data: T) => void): boolean => {
		const idx = this.listeners.indexOf(fn)
		if (idx >= 0) {
			this.listeners.splice(idx, 1)
			return true
		}

		return false
	}
	clear = (): void => {
		this.listeners = []
	}
	call = (data: T): void => {
		for (const fn of this.listeners) {
			try {
				fn(data)
			} catch {}
		}
	}
}

class WorkerSyncedMessagePort {
	private $1: Record<string, SimpleHook<WorkerMessage>> = {}
	public onUnhandledMessage = new SimpleHook<WorkerMessage>()
	public onMessage = new SimpleHook<WorkerMessage>()
	public onPostMessage = new SimpleHook<unknown>()
	public onError = new SimpleHook<unknown>()
	private $2: unknown
	public name: string

	constructor(port: unknown, name: string) {
		this.$2 = port
		this.name = name

		if (parentPort) {
			// Host messages are trusted to follow the `WorkerMessage` shape; the
			// dispatcher below tolerates missing routing keys.
			parentPort.on('message', (data: unknown) => {
				this.onMessageHandler(data as WorkerMessage)
			})
		}
	}

	onMessageHandler(data: WorkerMessage): void {
		try {
			this.onMessage.call(data)
			let handled = false
			const dispatch = (key?: string): void => {
				if (!key) return
				const hook = this.$1[key]
				if (hook) {
					handled = true
					hook.call(data)
				}
			}

			dispatch(data.type)
			if (data.cmd !== data.type) dispatch(data.cmd)
			if (!handled) this.onUnhandledMessage.call(data)
		} catch (e) {
			this.onError.call(e)
		}
	}

	postMessage(data: unknown, transfer?: readonly TransferListItem[]): void {
		this.onPostMessage.call(data)
		if (parentPort) {
			if (transfer) parentPort.postMessage(data, transfer)
			else parentPort.postMessage(data)
		}
	}

	addMessageListener(type: string, fn: (data: WorkerMessage) => void): (data: WorkerMessage) => void {
		let hook = this.$1[type]
		if (!hook) {
			hook = new SimpleHook<WorkerMessage>()
			this.$1[type] = hook
		}

		return hook.add(fn)
	}

	removeMessageListener(type: string, fn: (data: WorkerMessage) => void): boolean {
		const hook = this.$1[type]
		return !!hook && hook.remove(fn)
	}

	removeAllMessageListeners(type: string): void {
		const hook = this.$1[type]
		if (hook) hook.clear()
	}
}

const WABinary = {
	Binary: {
		build: function (data: BinaryInput) {
			return {
				readByteArrayView: function (): Uint8Array {
					if (data instanceof Uint8Array) return data
					if (typeof data === 'string') return new TextEncoder().encode(data)
					if (Array.isArray(data)) return new Uint8Array(data)
					if (Buffer.isBuffer(data)) return new Uint8Array(data)
					if (data instanceof ArrayBuffer) return new Uint8Array(data)
					if (ArrayBuffer.isView(data)) {
						return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
					}

					if (typeof data === 'object' && data !== null && typeof data.length === 'number') {
						const arr = new Uint8Array(data.length)
						for (let i = 0; i < data.length; i++) arr[i] = data[i] || 0
						return arr
					}

					return new Uint8Array(0)
				}
			}
		}
	}
}

const WACryptoHkdfSync = {
	hkdf: function (
		key: Uint8Array,
		salt: Uint8Array | undefined,
		info: Uint8Array | Buffer | undefined,
		length: number
	): Uint8Array {
		const prk = crypto
			.createHmac('sha256', salt || Buffer.alloc(32))
			.update(key)
			.digest()
		const n = Math.ceil(length / 32)
		const okm = Buffer.alloc(n * 32)
		let prev = Buffer.alloc(0)
		for (let i = 0; i < n; i++) {
			prev = crypto
				.createHmac('sha256', prk)
				.update(Buffer.concat([prev, (info as Buffer) || Buffer.alloc(0), Buffer.from([i + 1])]))
				.digest()
			prev.copy(okm, i * 32)
		}

		return new Uint8Array(okm.slice(0, length))
	}
}

class Sha256HMacBuilder {
	private hmac: crypto.Hmac

	constructor(key: Uint8Array | Buffer) {
		this.hmac = crypto.createHmac('sha256', key)
	}

	update(data: Uint8Array | Buffer): this {
		this.hmac.update(data)
		return this
	}

	finish(): Uint8Array {
		return new Uint8Array(this.hmac.digest())
	}
}

// Re-export wrapper that mirrors `WACryptoSha256HmacBuilder` from the WA Web
// bundle. Not currently consumed in-process — the WASM callbacks use
// `Sha256HMacBuilder` directly. Prefix avoids the unused-var lint.
const _WACryptoSha256HmacBuilder = { Sha256HMacBuilder }

const WAWebVoipPersistentFS = {
	getVoipPersistentDirectoryPath: function (): string {
		return path.join(os.tmpdir(), 'voip')
	},
	initPersistentFS: async function (_module?: unknown): Promise<void> {
		return Promise.resolve()
	}
}

let WAWebVoipJsWorkerMessageHandler: JsWorkerMessageHandlerModule = {
	handleJsWorkerMessage: function () {}
}

const getPreferredLoaderModuleNames = (): string[] => {
	return [
		typedWorkerData?.loaderModuleName,
		'WAWebVoipWebWasmLoader',
		'WAWebVoipWebWasmLoader.worker',
		'WAWebVoipWebWasmLoader_ProdLab_internal.worker',
		'WAWebVoipWebWasmLoader_ProdLabvideo_internal.worker'
	].filter((value, index, array) => !!value && array.indexOf(value) === index) as string[]
}

const resolveLoaderModule = (): Function | null => {
	for (const moduleName of getPreferredLoaderModuleNames()) {
		try {
			const loaderModule = global.__r(moduleName)
			const resolved = loaderModule?.default ?? loaderModule
			if (typeof resolved === 'function') {
				return resolved
			}
		} catch (e) {}
	}

	return null
}

const nullthrows = <T>(value: T | null | undefined): T => {
	if (value == null) throw new Error('Got unexpected null or undefined')
	return value
}

const asyncToGeneratorRuntime = {
	asyncToGenerator: function (fn: Function) {
		return function (this: unknown, ...args: any[]) {
			const gen = fn.apply(this, args)
			return new Promise((resolve, reject) => {
				function step(key: string, arg?: unknown) {
					try {
						const info = gen[key](arg)
						const value = info.value
						if (info.done) resolve(value)
						else
							Promise.resolve(value).then(
								(val: unknown) => step('next', val),
								(err: unknown) => step('throw', err)
							)
					} catch (e) {
						reject(e)
					}
				}

				step('next', undefined)
			})
		}
	}
}

const e = new WorkerSyncedMessagePort(global.self, 'VoipWebWasmWorker')

global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks = {
	onSignalingXmpp: function (n: SignalingXmppArgs) {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'onSignalingXmpp',
			peerJid: n.peerJid,
			callId: n.callId,
			xmlPayload: n.xmlPayload
		})
	},

	onCallEvent: function (n: CallEventArgs) {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'onCallEvent',
			eventType: n.eventType,
			userData: n.userData,
			eventDataJson: n.eventDataJson
		})
	},

	sendDataToRelay: function (n: RelayPacketArgs) {
		const t = n.data
		const r = n.len
		const o = n.ip
		const a = n.port

		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'sendDataToRelay',
			data: t,
			len: r,
			ip: o,
			port: a
		})

		return r || (t ? t.length || t.byteLength || 0 : 0)
	},

	loggingCallback: function (n: ForwardedCallbackArgs) {
		try {
			e.postMessage(Object.assign({ type: 'waWasmWorkerCompatibleCallback', __name: 'loggingCallback' }, n))
		} catch (err) {}
	},

	initCaptureDriverJS: function (n: ForwardedCallbackArgs) {
		e.postMessage(Object.assign({ type: 'waWasmWorkerCompatibleCallback', __name: 'initCaptureDriverJS' }, n))
		return 0
	},

	startCaptureJS: function () {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'startCaptureJS'
		})
		return 0
	},

	stopCaptureJS: function () {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'stopCaptureJS'
		})
		return 0
	},

	initPlaybackDriverJS: function (n: ForwardedCallbackArgs) {
		e.postMessage(Object.assign({ type: 'waWasmWorkerCompatibleCallback', __name: 'initPlaybackDriverJS' }, n))
		return 0
	},

	startPlaybackJS: function () {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'startPlaybackJS'
		})
		return 0
	},

	stopPlaybackJS: function () {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'stopPlaybackJS'
		})
		return 0
	},

	startVideoCaptureJS: function (n: ForwardedCallbackArgs) {
		e.postMessage(Object.assign({ type: 'waWasmWorkerCompatibleCallback', __name: 'startVideoCaptureJS' }, n))
		return 0
	},

	stopVideoCaptureJS: function () {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'stopVideoCaptureJS'
		})
		return 0
	},

	onVideoFrameWasmToJs: function (n: VideoFrameArgs) {
		e.postMessage(
			{
				type: 'waWasmWorkerCompatibleCallback',
				__name: 'onVideoFrameWasmToJs',
				userJid: n.userJid,
				frameBuffer: n.frameBuffer,
				width: n.width,
				height: n.height,
				orientation: n.orientation,
				format: n.format,
				timestamp: n.timestamp,
				isKeyFrame: n.isKeyFrame
			},
			[n.frameBuffer]
		)
	},

	startDesktopCaptureJS: function (n: ForwardedCallbackArgs) {
		e.postMessage(Object.assign({ type: 'waWasmWorkerCompatibleCallback', __name: 'startDesktopCaptureJS' }, n))
		return 0
	},

	stopDesktopCaptureJS: function () {
		e.postMessage({
			type: 'waWasmWorkerCompatibleCallback',
			__name: 'stopDesktopCaptureJS'
		})
		return 0
	},

	cryptoHkdfExtractWithSaltAndExpand: function (t: HkdfArgs) {
		const i = new Uint8Array(t.key_)
		const l = t.salt_ ? new Uint8Array(t.salt_) : undefined
		const s = WABinary.Binary.build(t.info_).readByteArrayView()
		return WACryptoHkdfSync.hkdf(i, l, s, t.length)
	},

	hmacSha256KeyGenerator: function (t: HmacArgs) {
		const r = new Uint8Array(t.data_)
		const a = new Uint8Array(t.key_)
		return new Sha256HMacBuilder(a).update(r).finish()
	},

	isParticipantKnownContact: function (_t: unknown) {
		return false
	},

	getPersistentDirectoryPath: function () {
		return WAWebVoipPersistentFS.getVoipPersistentDirectoryPath()
	},

	getBrowserAudioProcessingStatus: function () {
		return 7
	},

	getBweModelPath: function () {
		return null
	},

	videoFrameConsumed: function () {},

	dataChannelStateCallback: function () {}
} as WhatsAppVoipWasmWorkerCompatibleCallbacks

let wasmLoader: Function | null = null

if (typedWorkerData && (typedWorkerData.loaderCode || typedWorkerData.workerModulesCode)) {
	try {
		const modulePrelude = 'var __d = global.__d, __r = global.__r;\n'
		const savedCallbacks = global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks

		if (typedWorkerData.workerModulesCode) {
			const workerScript = new vm.Script(modulePrelude + typedWorkerData.workerModulesCode, {
				filename: 'workerModulesCode-SEM22icu2S7.js'
			})
			workerScript.runInThisContext()
		}

		if (typedWorkerData.loaderCode) {
			const loaderScript = new vm.Script(modulePrelude + typedWorkerData.loaderCode, {
				filename: 'loaderCode-1eFv_3F3hOU.js'
			})
			loaderScript.runInThisContext()
		}

		if (!global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks?.loggingCallback) {
			global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks = savedCallbacks
			if (global.self !== global.self) {
				global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks = savedCallbacks
			}
		}

		if (global.self !== global.self) {
			// `currentSelf` is the same reference as `global.self`; reading it once
			// keeps these (no-op) re-assignments from being literal self-assignments.
			const currentSelf = global.self
			if (currentSelf.WhatsAppVoipWasmWorkerCompatibleCallbacks) {
				global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks = currentSelf.WhatsAppVoipWasmWorkerCompatibleCallbacks
			} else if (currentSelf.WhatsAppVoipWasmWorkerCompatibleCallbacks) {
				global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks = currentSelf.WhatsAppVoipWasmWorkerCompatibleCallbacks
			}

			global.self = currentSelf
		}

		wasmLoader = resolveLoaderModule()

		try {
			const jsWorkerModule = global.__r('WAWebVoipJsWorkerMessageHandler')
			if (jsWorkerModule) {
				WAWebVoipJsWorkerMessageHandler = (jsWorkerModule.default ?? jsWorkerModule) as JsWorkerMessageHandlerModule
			}
		} catch (e) {}
	} catch (e) {}
}

if (!wasmLoader) {
	const resourcesPath = typedWorkerData?.resourcesPath || path.join(_wbDirname, 'wasm-resources')
	const rsrcPath = path.join(resourcesPath, 'loader.js')
	if (fs.existsSync(rsrcPath)) {
		try {
			const loaderCode = fs.readFileSync(rsrcPath, 'utf8')
			const savedCallbacks = global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks

			const script = new vm.Script(loaderCode, { filename: rsrcPath })
			script.runInThisContext()

			if (!global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks?.loggingCallback) {
				global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks = savedCallbacks
			}

			wasmLoader = resolveLoaderModule()
		} catch (e) {}
	}
}

let s: VoipEmscriptenModule = {}
let u = false
let _: VoipEmscriptenModule | null = null
let jsWorkerRawVideoFramePtr = 0
let jsWorkerRawVideoFrameSize = 0

const c = (condition: boolean, msg: string): void => {
	if (!condition) throw 'Assertion failed: ' + msg
}

const d = (..._args: any[]): void => {}

const m = (...args: any[]): void => {
	const text = args.join(' ')
	global.postMessage({
		cmd: 'alert',
		text: text,
		threadId: s._pthread_self ? s._pthread_self() : undefined
	})
}

const p = d
global.self.alert = m

s.instantiateWasm = function (
	imports: WebAssembly.Imports,
	successCallback: (instance: WebAssembly.Instance) => unknown
) {
	const wasmModule = nullthrows(s.wasmModule)
	s.wasmModule = null
	const instance = new WebAssembly.Instance(wasmModule, imports)
	return successCallback(instance)
}
// eslint-disable-next-line padding-line-between-statements
global.self.onunhandledrejection = function (event: UnhandledRejectionLike) {
	throw event.reason ?? event
}

const getActiveWasmModule = (): VoipEmscriptenModule => {
	return _ || global.self.__waModule || s
}

const releaseJsWorkerRawVideoFrameBuffer = (moduleRef: VoipEmscriptenModule | null | undefined): void => {
	if (jsWorkerRawVideoFramePtr && moduleRef && typeof moduleRef._free === 'function') {
		try {
			moduleRef._free(jsWorkerRawVideoFramePtr)
		} catch {}
	}

	jsWorkerRawVideoFramePtr = 0
	jsWorkerRawVideoFrameSize = 0
}

const handleRawVideoFrameOnJsWorker = (msg: WorkerMessage): void => {
	const moduleRef = getActiveWasmModule()
	const sendFrameFn = msg?.useDesktopCapture ? moduleRef?.onDesktopCaptureDataFromJs : moduleRef?.onVideoDataFromJs
	const frameBuffer = msg?.frameBuffer
	const width = Math.max(0, Math.trunc(Number(msg?.width || 0)))
	const height = Math.max(0, Math.trunc(Number(msg?.height || 0)))
	const fps = Math.max(1, Math.trunc(Number(msg?.fps || 0)) || 1)
	const orientation = Math.trunc(Number(msg?.orientation || 0))
	const format = Math.trunc(Number(msg?.format || 0))
	const timestamp = Math.trunc(Number(msg?.timestamp || 0))

	if (
		!moduleRef ||
		typeof moduleRef._malloc !== 'function' ||
		typeof moduleRef._free !== 'function' ||
		typeof sendFrameFn !== 'function' ||
		!(frameBuffer instanceof ArrayBuffer || ArrayBuffer.isView(frameBuffer))
	) {
		return
	}

	const bytes = ArrayBuffer.isView(frameBuffer)
		? new Uint8Array(frameBuffer.buffer as ArrayBuffer, frameBuffer.byteOffset, frameBuffer.byteLength)
		: new Uint8Array(frameBuffer)
	if (bytes.byteLength === 0 || width <= 0 || height <= 0) {
		return
	}

	if (!jsWorkerRawVideoFramePtr || jsWorkerRawVideoFrameSize < bytes.byteLength) {
		releaseJsWorkerRawVideoFrameBuffer(moduleRef)
		jsWorkerRawVideoFramePtr = Number(moduleRef._malloc(bytes.byteLength)) || 0
		jsWorkerRawVideoFrameSize = jsWorkerRawVideoFramePtr ? bytes.byteLength : 0
	}

	if (!jsWorkerRawVideoFramePtr || jsWorkerRawVideoFrameSize < bytes.byteLength) {
		return
	}

	moduleRef.GROWABLE_HEAP_U8!().set(bytes, jsWorkerRawVideoFramePtr)

	try {
		sendFrameFn.call(moduleRef, jsWorkerRawVideoFramePtr, bytes.byteLength, width, height, fps, format, orientation)
	} catch (error) {
		if ((error as ErrorLike | null | undefined)?.name !== 'BindingError') {
			throw error
		}

		try {
			sendFrameFn.call(moduleRef, jsWorkerRawVideoFramePtr, bytes.byteLength, width, height, fps, format)
		} catch (legacyError) {
			if ((legacyError as ErrorLike | null | undefined)?.name !== 'BindingError') {
				throw legacyError
			}

			sendFrameFn.call(
				moduleRef,
				jsWorkerRawVideoFramePtr,
				bytes.byteLength,
				width,
				height,
				orientation,
				format,
				timestamp
			)
		}
	}
}

function f(t: WorkerMessage): void {
	try {
		if (t.cmd === 'load') {
			const wasmModule = t.wasmModule
			const wasmMemory = t.wasmMemory!
			const workerID = t.workerID
			const handlers = t.handlers!
			const pendingMessages: WorkerMessage[] = []

			function g(msg: WorkerMessage): void {
				pendingMessages.push(msg)
			}

			e.removeMessageListener('cmd', f)
			e.addMessageListener('cmd', g)
			global.self.startWorker = function (module: VoipEmscriptenModule): void {
				global.self.__waModule = module
				global.__waModule = module
				s = module
				e.postMessage({ type: 'cmd', cmd: 'loaded' })
				for (const msg of pendingMessages) f(msg)
				e.removeMessageListener('cmd', g)
				e.addMessageListener('cmd', f)
			}

			s.wasmModule = wasmModule

			function h(name: string): void {
				s[name] = function () {
					const args = Array.from(arguments)
					e.postMessage({
						type: 'cmd',
						cmd: 'callHandler',
						callHandler: { handler: name, args: args }
					})
				}
			}

			for (const handler of handlers) h(handler)

			s.wasmMemory = wasmMemory
			s.buffer = s.wasmMemory.buffer
			s.workerID = workerID
			s.ENVIRONMENT_IS_PTHREAD = true

			if (!s.WhatsAppVoipWasmWorkerCompatibleCallbacks) {
				s.WhatsAppVoipWasmWorkerCompatibleCallbacks = global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks
			}

			if (wasmLoader) {
				hideNodeEnv()
				wasmLoader(s)
					.then(
						asyncToGeneratorRuntime.asyncToGenerator(function* (module: VoipEmscriptenModule) {
							if (!module.WhatsAppVoipWasmWorkerCompatibleCallbacks) {
								module.WhatsAppVoipWasmWorkerCompatibleCallbacks = global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks
							}

							if (!s.WhatsAppVoipWasmWorkerCompatibleCallbacks?.loggingCallback) {
								s.WhatsAppVoipWasmWorkerCompatibleCallbacks = global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks
							}

							_ = module
							try {
								yield WAWebVoipPersistentFS.initPersistentFS(_)
							} catch (err) {}
						})
					)
					// Without .catch() a loader rejection becomes a pending Promise:
					// the worker never sends a message and the parent deadlocks
					// waiting. Forward as a distinct error message so the parent
					// can fail deterministically. Earlier we sent `cmd: 'loaded'`
					// with an error attr — that hit the loaded-handler in the
					// parent and made init appear to succeed while the worker
					// was broken. `cmd: 'error'` ensures the failure surfaces.
					.catch((err: unknown) => {
						try {
							e.postMessage({
								type: 'cmd',
								cmd: 'error',
								error: String((err as ErrorLike | null | undefined)?.message ?? err ?? 'wasmLoader rejected')
							})
						} catch {}
					})
			} else {
				e.postMessage({ type: 'cmd', cmd: 'loaded' })
			}
		} else if (t.cmd === 'run') {
			const pthread_ptr = t.pthread_ptr!

			if (s.__emscripten_thread_init) s.__emscripten_thread_init(pthread_ptr, 0, 0, 1)
			if (s.__emscripten_thread_mailbox_await) s.__emscripten_thread_mailbox_await(pthread_ptr)

			c(!!pthread_ptr, 'pthread_ptr is required in event ' + t.cmd)

			if (s.establishStackSpace) s.establishStackSpace()
			if (s.PThread) s.PThread.receiveObjectTransfer(t)
			if (s.PThread) s.PThread.threadInitTLS()

			if (!u) {
				if (s.__embind_initialize_bindings) s.__embind_initialize_bindings()
				u = true
			}

			try {
				if (s.invokeEntryPoint) s.invokeEntryPoint(t.start_routine, t.arg)
			} catch (err) {
				if (err !== 'unwind') throw err
			}
		} else if (t.cmd === 'cancel') {
			if (s._pthread_self?.()) {
				if (s.__emscripten_thread_exit) s.__emscripten_thread_exit(-1)
			}
		} else if (t.target !== 'setimmediate') {
			if (t.cmd === 'checkMailbox') {
				if (u && s.checkMailbox) s.checkMailbox()
			} else if (t.cmd === 'jsWorkerCmd') {
				return
			} else if (t.cmd) {
				p('worker.js received unknown command ' + t.cmd)
				p(t)
			}
		}
	} catch (err) {
		p('worker.js onmessage() captured an uncaught exception: ' + err)
		if ((err as ErrorLike | null | undefined)?.stack) p((err as ErrorLike).stack)
		if (s.__emscripten_thread_crashed) s.__emscripten_thread_crashed()
		throw err
	}
}

e.addMessageListener('cmd', f)

e.addMessageListener('jsWorkerCmd', function (msg: WorkerMessage): void {
	try {
		if (msg?.jsWorkerCmd === 'pushRawVideoFrame') {
			return handleRawVideoFrameOnJsWorker(msg)
		}

		if (msg?.jsWorkerCmd === 'releaseRawVideoFrameBuffer') {
			return releaseJsWorkerRawVideoFrameBuffer(getActiveWasmModule())
		}

		return WAWebVoipJsWorkerMessageHandler.handleJsWorkerMessage(_, msg)
	} catch (err) {
		throw err
	}
})

e.addMessageListener('waWasmWorkerCompatibleCallback', function (msg: WorkerMessage): void {
	const callbackName = msg.__name
	if (!callbackName) return

	if (!global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks) return
	if (typeof global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks[callbackName] !== 'function') return

	try {
		if (['startCaptureJS', 'startPlaybackJS', 'stopCaptureJS', 'stopPlaybackJS'].includes(callbackName)) {
			global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks[callbackName]()
		} else {
			const args: Record<string, unknown> = {}
			for (const key in msg) {
				if (key !== 'type' && key !== '__name' && !key.startsWith('__')) args[key] = msg[key]
			}

			global.self.WhatsAppVoipWasmWorkerCompatibleCallbacks[callbackName](args)
		}
	} catch (err) {}
})

if (parentPort) {
	parentPort.postMessage({ type: 'worker_ready' })
}
