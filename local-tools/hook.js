/**
 * Active Play Integrity agent for the InfiniteAPI native Android bridge.
 * The agent mirrors the integrity provider request used by the native WhatsApp
 * client. WhatsApp labels the stream challenge safetynet, but its native
 * integrity provider resolves through Play Integrity Classic token requests.
 */

let listenerSequence = 0
let keyStoreSequence = 0
let lastJniHandlerError = null
let registrationWireCaptures = []
let spyOutputStreamSequence = 0
let cjtWriteHistory = []
let cjtArmedLoaderKeys = new Set()
let retryingArmedLoaderKeys = new Set()
let trackedCjtInstances = []
let cjtHeapScanScheduled = false
let REGISTRATION_CAPTURE_HMAC_KEY_B64 = null
if (typeof REGISTRATION_CAPTURE_HMAC_KEY_B64_OVERRIDE !== 'undefined') {
  REGISTRATION_CAPTURE_HMAC_KEY_B64 = REGISTRATION_CAPTURE_HMAC_KEY_B64_OVERRIDE
}

function currentContextPackage() {
  try {
    const ActivityThread = Java.use('android.app.ActivityThread')
    const context = ActivityThread.currentApplication()
    return context ? String(context.getPackageName()) : 'unknown'
  } catch (error) {
    return 'unknown'
  }
}

function recordRegistrationCapture(capture) {
  capture.package = capture.package || currentContextPackage()
  registrationWireCaptures.unshift(capture)
  registrationWireCaptures = registrationWireCaptures.slice(0, 200)
  try {
    send({ type: 'wire-capture', capture: capture })
  } catch (sendError) {
    // Non-fatal: the in-memory copy still exists for the pull path.
  }
}

function captureBodyBytes(bytes, offset, length) {
  let text = ''
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    const byte = bytes[index] < 0 ? bytes[index] + 256 : bytes[index]
    text += String.fromCharCode(byte)
  }
  if (looksLikeRegistrationQuery(text)) {
    recordRegistrationCapture({
      at: new Date().toISOString(),
      source: 'spied-stream',
      body: text
    })
    agentLog('captured official registration body via spied stream length=' + text.length)
  }
}

function javaBytesToText(value, limit = 16384) {
  if (value === null) return null
  const size = value.length
  let text = ''
  const end = Math.min(size, limit)
  for (let index = 0; index < end; index += 1) {
    text += String.fromCharCode(value[index] < 0 ? value[index] + 256 : value[index])
  }
  return { size, text, truncated: size > end }
}

function mapToPlainJava(value) {
  if (value === null) return null
  const result = {}
  const entries = value.entrySet().toArray()
  for (let index = 0; index < entries.length; index += 1) {
    result[String(entries[index].getKey())] = String(entries[index].getValue())
  }
  return result
}

function sha256Base64FromBytes(bytes) {
  const MessageDigest = Java.use('java.security.MessageDigest')
  const digest = MessageDigest.getInstance('SHA-256').digest(bytes)
  const Base64 = Java.use('android.util.Base64')
  return String(Base64.encodeToString(digest, 2))
}

function sha256Base64FromString(value) {
  const StringJava = Java.use('java.lang.String')
  return sha256Base64FromBytes(StringJava.$new(value).getBytes('UTF-8'))
}

function hmacSha256Base64FromBytes(bytes) {
  if (!REGISTRATION_CAPTURE_HMAC_KEY_B64) return null
  const Base64 = Java.use('android.util.Base64')
  const SecretKeySpec = Java.use('javax.crypto.spec.SecretKeySpec')
  const Mac = Java.use('javax.crypto.Mac')
  const keyBytes = Base64.decode(REGISTRATION_CAPTURE_HMAC_KEY_B64, 2)
  const mac = Mac.getInstance('HmacSHA256')
  mac.init(SecretKeySpec.$new(keyBytes, 'HmacSHA256'))
  const digest = mac.doFinal(bytes)
  return String(Base64.encodeToString(digest, 2))
}

function hmacSha256Base64FromString(value) {
  const StringJava = Java.use('java.lang.String')
  return hmacSha256Base64FromBytes(StringJava.$new(value).getBytes('UTF-8'))
}

function valueClassification(key, value) {
  const className = String(value.getClass().getName())
  if (className === '[B') {
    const bytes = Java.array('byte', value)
    return {
      kind: 'bytes',
      byteLength: bytes.length,
      encoding: 'binary',
      hmacSha256: hmacSha256Base64FromBytes(value),
      value: '<redacted-binary>'
    }
  }

  const text = String(value)
  const safeTextKeys = new Set([
    'lg', 'lc', 'platform', 'method', 'current_screen', 'previous_screen',
    'action_taken', 'event_name', 'clicked_education_link',
    'manage_call_permission', 'call_log_permission'
  ])
  if (safeTextKeys.has(key)) {
    return { kind: 'text', charLength: text.length, encoding: 'UTF-8', value: text }
  }
  if (key === 'cc' || key === 'in') {
    return { kind: 'text', charLength: text.length, encoding: 'UTF-8', value: '<redacted-phone>' }
  }
  return {
    kind: 'text',
    charLength: text.length,
    encoding: 'UTF-8',
    hmacSha256: hmacSha256Base64FromString(text),
    value: '<redacted>'
  }
}

function orderedFieldClassification(value) {
  const MapClass = Java.use('java.util.Map')
  const EntryClass = Java.use('java.util.Map$Entry')
  const map = Java.cast(value, MapClass)
  const entries = map.entrySet().toArray()
  const result = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = Java.cast(entries[index], EntryClass)
    const key = String(entry.getKey())
    const rawValue = entry.getValue()
    result.push({
      ordinal: index,
      path: '$.' + key,
      name: key,
      null: rawValue === null,
      empty: rawValue !== null && String(rawValue) === '',
      ...(rawValue === null ? { kind: 'null', value: null } : valueClassification(key, rawValue))
    })
  }
  return result
}

function recordCjtWrite(method, key, applied, rawValue) {
  cjtWriteHistory.push({
    at: new Date().toISOString(),
    method,
    path: '$.' + key,
    name: key,
    applied: applied === true,
    null: rawValue === null,
    empty: rawValue !== null && String(rawValue) === '',
    ...(rawValue === null ? {} : valueClassification(key, rawValue))
  })
  if (cjtWriteHistory.length > 1000) cjtWriteHistory.shift()
}

function javaMapToOrderedClassification(value) {
  const MapClass = Java.use('java.util.Map')
  const EntryClass = Java.use('java.util.Map$Entry')
  const map = Java.cast(value, MapClass)
  const entries = map.entrySet().toArray()
  const result = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = Java.cast(entries[index], EntryClass)
    const key = String(entry.getKey())
    const rawValue = entry.getValue()
    result.push({
      key,
      ...(rawValue === null ? { kind: 'null' } : valueClassification(key, rawValue))
    })
  }
  return result
}

// ---- Opção A: rastreio de instâncias CJT via construtor ----
// R8 pode inlining os métodos helper (A00-A07), mas o construtor <init>
// permanece no DEX porque a alocação new-instance não pode ser eliminada.

function installCjtConstructorTracking(loader, loaderDescription) {
  const factory = Java.ClassFactory.get(loader)
  const CJT = factory.use('X.CJT')
  for (const overload of CJT.$init.overloads) {
    overload.implementation = function (...args) {
      const result = overload.apply(this, args)
      try {
        trackedCjtInstances.push({
          ref: Java.retain(this),
          at: Date.now(),
          loader: loaderDescription
        })
        if (trackedCjtInstances.length > 50) trackedCjtInstances.shift()
        agentLog('CJT constructor tracked, total=' + trackedCjtInstances.length)
      } catch (trackError) {
        agentLog('CJT constructor tracking failed: ' + trackError)
      }
      return result
    }
  }
  return true
}

function dumpTrackedCjtInstances(trigger) {
  const now = Date.now()
  const recent = trackedCjtInstances.filter(function (t) { return now - t.at < 30000 })
  if (recent.length === 0) {
    agentLog('CJT tracked dump: no recent instances, trigger=' + trigger)
    return
  }
  for (let index = 0; index < recent.length; index += 1) {
    const tracked = recent[index]
    try {
      const instance = tracked.ref
      const mapField = instance.A00
      if (mapField === undefined || mapField === null) {
        agentLog('CJT tracked dump: A00 field unavailable, instance=' + index)
        continue
      }
      const map = mapField.value
      if (map === null) {
        agentLog('CJT tracked dump: A00 value is null, instance=' + index)
        continue
      }
      const fields = orderedFieldClassification(map)
      if (fields.length > 0) {
        recordRegistrationCapture({
          at: new Date().toISOString(),
          source: 'cjt-tracked-dump',
          trigger: trigger,
          loader: tracked.loader,
          instanceIndex: index,
          fieldCount: fields.length,
          fields: fields
        })
        agentLog('CJT tracked dump: instance ' + index + ' fields=' + fields.length)
      } else {
        agentLog('CJT tracked dump: instance ' + index + ' map empty')
      }
    } catch (dumpError) {
      agentLog('CJT tracked dump failed, instance=' + index + ': ' + dumpError)
    }
  }
}

// ---- Fallback: heap scan com Java.choose() ----

function scheduleCjtHeapScan(trigger) {
  if (cjtHeapScanScheduled) return
  cjtHeapScanScheduled = true
  setTimeout(function () {
    cjtHeapScanScheduled = false
    Java.perform(function () {
      try {
        let found = 0
        Java.choose('X.CJT', {
          onInstance: function (instance) {
            found += 1
            try {
              const mapField = instance.A00
              if (mapField === undefined || mapField === null) return
              const map = mapField.value
              if (map === null) return
              const fields = orderedFieldClassification(map)
              if (fields.length > 0) {
                recordRegistrationCapture({
                  at: new Date().toISOString(),
                  source: 'cjt-heap-scan',
                  trigger: trigger,
                  fieldCount: fields.length,
                  fields: fields
                })
                agentLog('CJT heap scan: instance fields=' + fields.length)
              }
            } catch (readError) {
              agentLog('CJT heap scan field read failed: ' + readError)
            }
          },
          onComplete: function () {
            agentLog('CJT heap scan complete, trigger=' + trigger + ', found=' + found)
          }
        })
      } catch (scanError) {
        agentLog('CJT heap scan failed: ' + scanError)
      }
    })
  }, 50)
}

function installCjtCaptureForLoader(loader, loaderDescription) {
  const factory = Java.ClassFactory.get(loader)
  const CJT = factory.use('X.CJT')

  installCjtConstructorTracking(loader, loaderDescription)

  const putBoolean = CJT.A00.overload('java.lang.String', 'int')
  putBoolean.implementation = function (key, value) {
    const applied = value === 0 || value === 1
    const result = putBoolean.call(this, key, value)
    try {
      if (applied) {
        const JavaString = Java.use('java.lang.String')
        recordCjtWrite('A00', key, true, JavaString.$new(value === 0 ? 'false' : 'true'))
      }
    } catch (error) { agentLog('CJT A00 capture failed: ' + error) }
    return result
  }

  const putString = CJT.A01.overload('java.lang.String', 'java.lang.String')
  putString.implementation = function (key, value) {
    const result = putString.call(this, key, value)
    try { recordCjtWrite('A01', key, true, this.A00.value.get(key)) } catch (error) { agentLog('CJT A01 capture failed: ' + error) }
    return result
  }

  const putOptionalString = CJT.A02.overload('java.lang.String', 'java.lang.String')
  putOptionalString.implementation = function (key, value) {
    const result = putOptionalString.call(this, key, value)
    try { recordCjtWrite('A02', key, value !== null, value === null ? null : this.A00.value.get(key)) } catch (error) { agentLog('CJT A02 capture failed: ' + error) }
    return result
  }

  const putBase64 = CJT.A04.overload('java.lang.String', '[B')
  putBase64.implementation = function (key, value) {
    const result = putBase64.call(this, key, value)
    try { recordCjtWrite('A04', key, true, this.A00.value.get(key)) } catch (error) { agentLog('CJT A04 capture failed: ' + error) }
    return result
  }

  const putOptionalBase64 = CJT.A05.overload('java.lang.String', '[B')
  putOptionalBase64.implementation = function (key, value) {
    const result = putOptionalBase64.call(this, key, value)
    try { recordCjtWrite('A05', key, value !== null, value === null ? null : this.A00.value.get(key)) } catch (error) { agentLog('CJT A05 capture failed: ' + error) }
    return result
  }

  const putHex = CJT.A06.overload('java.lang.String', '[B')
  putHex.implementation = function (key, value) {
    const result = putHex.call(this, key, value)
    try { recordCjtWrite('A06', key, true, this.A00.value.get(key)) } catch (error) { agentLog('CJT A06 capture failed: ' + error) }
    return result
  }

  const mergeNativeMap = CJT.A07.overload('java.util.Map')
  mergeNativeMap.implementation = function (map) {
    const writeCount = cjtWriteHistory.length
    try {
      const fields = orderedFieldClassification(this.A00.value)
      const nativeMerge = map === null ? [] : orderedFieldClassification(map)
      const keys = new Set(fields.map(field => field.name))
      const requestKind = keys.has('token') && keys.has('method')
        ? 'request_code'
        : keys.has('code') ? 'register_or_security' : 'other'
      recordRegistrationCapture({
        at: new Date().toISOString(),
        source: 'cjt-final-map',
        loader: loaderDescription,
        threadId: Process.getCurrentThreadId(),
        requestKind,
        fields,
        nativeMerge,
        writeHistory: cjtWriteHistory.slice()
      })
      cjtWriteHistory = []
      agentLog('captured official CJT final map fields=' + fields.length +
        ' nativeMerge=' + nativeMerge.length + ' writes=' + writeCount +
        ' kind=' + requestKind + ' loader=' + loaderDescription)
    } catch (captureError) {
      agentLog('CJT final map capture failed: ' + captureError)
    }
    return mergeNativeMap.call(this, map)
  }

  return true
}

function scheduleCjtCapture() {
  let attempts = 0
  const timer = setInterval(function () {
    attempts += 1
    try {
      const loaders = Java.enumerateClassLoadersSync()
      for (let index = 0; index < loaders.length; index += 1) {
        const loader = loaders[index]
        const loaderKey = String(loader)
        const cjtArmed = cjtArmedLoaderKeys.has(loaderKey)
        const retryingArmed = retryingArmedLoaderKeys.has(loaderKey)
        if (cjtArmed && retryingArmed) continue
        try {
          if (!cjtArmed && installCjtCaptureForLoader(loader, loaderKey)) {
            cjtArmedLoaderKeys.add(loaderKey)
            agentLog('CJT capture armed loader=' + loaderKey)
          }
          if (!retryingArmed && installRetryingCaptureForLoader(loader, loaderKey)) {
            retryingArmedLoaderKeys.add(loaderKey)
            agentLog('RetryingHttpClient capture armed loader=' + loaderKey)
          }
        } catch (loaderError) {
          // Most loaders cannot resolve WhatsApp obfuscated classes.
        }
      }
      if (attempts >= 2400) clearInterval(timer)
    } catch (scheduleError) {
      agentLog('CJT capture schedule failed: ' + scheduleError)
      clearInterval(timer)
    }
  }, 250)
}

function installClassLoaderCjtCapture() {
  const BaseDexClassLoader = Java.use('dalvik.system.BaseDexClassLoader')
  for (const overload of BaseDexClassLoader.$init.overloads) {
    overload.implementation = function (...args) {
      const result = overload.call(this, ...args)
      try {
        const loaderKey = String(this)
        if (!cjtArmedLoaderKeys.has(loaderKey)) {
          if (installCjtCaptureForLoader(this, loaderKey + ' (new)')) {
            cjtArmedLoaderKeys.add(loaderKey)
            agentLog('CJT capture armed new loader=' + loaderKey)
          }
        }
      } catch (newLoaderError) {
        // A newly created loader may not contain WhatsApp classes.
      }
      try {
        const retryingLoaderKey = String(this)
        if (!retryingArmedLoaderKeys.has(retryingLoaderKey)) {
          if (installRetryingCaptureForLoader(this, retryingLoaderKey + ' (new)')) {
            retryingArmedLoaderKeys.add(retryingLoaderKey)
            agentLog('RetryingHttpClient capture armed new loader=' + retryingLoaderKey)
          }
        }
      } catch (newLoaderError) {
        // A newly created loader may not contain registration classes.
      }
      return result
    }
  }
}

function installRetryingCaptureForLoader(loader, loaderDescription) {
  const factory = Java.ClassFactory.get(loader)
  const Client = factory.use('com.whatsapp.registration.core.http.retry.RetryingHttpClient')
  for (const overload of Client.A01.overloads) {
    overload.implementation = function (...args) {
      try {
        const candidate = args[0]
        const className = candidate === null ? 'null' : String(candidate.getClass().getName())
        if (className === 'X.CJT') {
          const fields = orderedFieldClassification(candidate.A00.value)
          recordRegistrationCapture({
            at: new Date().toISOString(),
            source: 'retrying-final-map',
            loader: loaderDescription,
            threadId: Process.getCurrentThreadId(),
            endpointKey: String(args[3] ?? ''),
            fields,
            fieldCount: fields.length
          })
          agentLog('captured official RetryingHttpClient map fields=' + fields.length +
            ' endpointKey=' + String(args[3] ?? '') + ' loader=' + loaderDescription)
        }
      } catch (captureError) {
        agentLog('RetryingHttpClient capture failed: ' + captureError)
      }
      return overload.apply(this, args)
    }
  }
  return true
}

function installMsysWireCapture() {
  // MSYS is the network bridge used by the official 2.26.36.72 registration
  // flow. Its DataTask wraps the fully built UrlRequest, including query,
  // method, headers and body, after native code constructs the request.
  const DataTask = Java.use('com.facebook.msys.mci.DataTask')
  for (const overload of DataTask.$init.overloads) {
    overload.implementation = function (...args) {
      const result = overload.call(this, ...args)
      try {
        // The constructor signature is stable in 2.26.36.72:
        // category, identifier, type, UrlRequest, contentUrl,
        // contentLength, mode, nativeContext. Using the argument avoids
        // Frida field-wrapper ambiguity immediately after construction.
        const UrlRequest = Java.use('com.facebook.msys.mci.UrlRequest')
        const request = Java.cast(args[3], UrlRequest)
        const url = String(request.getUrl())
        if (url.indexOf('/v2/') !== -1 && url.indexOf('client_log') === -1) {
          const diagnostic = {}
          let method = null
          let body = null
          let headers = null
          try {
            method = String(request.getHttpMethod())
          } catch (methodError) {
            diagnostic.methodError = String(methodError)
          }
          try {
            body = javaBytesToText(request.getHttpBody())
          } catch (bodyError) {
            diagnostic.bodyError = String(bodyError)
          }
          try {
            headers = mapToPlainJava(request.getHttpHeaders())
          } catch (headerError) {
            headers = { captureError: String(headerError) }
            diagnostic.headerError = String(headerError)
          }
          recordRegistrationCapture({
            at: new Date().toISOString(),
            source: 'msys-request',
            task: {
              category: String(args[0]),
              identifier: String(args[1]),
              type: String(args[2]),
              mode: String(args[6]),
              contentUrl: String(args[4]),
              contentLength: String(args[5])
            },
            request: {
              url,
              method,
              headers,
              body
            },
            diagnostic
          })
          agentLog('captured official MSYS v2 request url=' + url +
            ' method=' + (method === null ? 'unavailable' : method) +
            ' body=' + (body === null ? 'unavailable' : String(body.size)) +
            (Object.keys(diagnostic).length ? ' diagnostic=' + JSON.stringify(diagnostic) : ''))
        }
      } catch (captureError) {
        agentLog('MSYS request capture failed: ' + captureError)
      }
      return result
    }
  }

  const NetworkSession = Java.use('com.facebook.msys.mci.NetworkSession')
  for (const overload of NetworkSession.markDataTaskAsCompletedCallback.overloads) {
    overload.implementation = function (...args) {
      try {
        const identifier = String(args[1])
        const body = javaBytesToText(args[4])
        recordRegistrationCapture({
          at: new Date().toISOString(),
          source: 'msys-response',
          package: currentContextPackage(),
          identifier,
          status: args[2],
          body
        })
        agentLog('captured official MSYS v2 response id=' + identifier + ' status=' + args[2])
      } catch (captureError) {
        agentLog('MSYS response capture failed: ' + captureError)
      }
      return overload.apply(this, args)
    }
  }
}

function scheduleMsysWireCapture() {
  // Referencing either class before WhatsApp initializes SoLoader triggers
  // NetworkSession.<clinit> too early and kills the process. Wait until the
  // normal app startup has loaded both classes, then arm the capture.
  const timer = setInterval(function () {
    try {
      const loaded = new Set(Java.enumerateLoadedClassesSync())
      if (!loaded.has('com.facebook.msys.mci.DataTask') ||
          !loaded.has('com.facebook.msys.mci.NetworkSession')) {
        return
      }
      clearInterval(timer)
      installMsysWireCapture()
      agentLog('msys wire capture armed after MSYS class load')
    } catch (scheduleError) {
      agentLog('MSYS capture schedule failed: ' + scheduleError)
    }
  }, 250)
}

function agentLog(message) {
  console.log('[BRIDGE] ' + message)
}

function listenerName(prefix) {
  listenerSequence += 1
  return 'com.infiniteapi.bridge.' + prefix + Date.now() + '.' + listenerSequence
}

function makeSuccessListener(prefix, onSuccess) {
  const OnSuccessListener = Java.use('com.google.android.gms.tasks.OnSuccessListener')
  return Java.registerClass({
    name: listenerName(prefix + 'Success'),
    implements: [OnSuccessListener],
    methods: { onSuccess: onSuccess }
  })
}

function makeFailureListener(prefix, reject) {
  const OnFailureListener = Java.use('com.google.android.gms.tasks.OnFailureListener')
  return Java.registerClass({
    name: listenerName(prefix + 'Failure'),
    implements: [OnFailureListener],
    methods: {
      onFailure: function(error) {
        reject(new Error(error && error.getMessage ? String(error.getMessage()) : String(error)))
      }
    }
  })
}

function javaByteArray(bytes) {
  return Java.array('byte', Array.from(bytes, byte => (byte & 0x80) ? byte - 256 : byte))
}

// Os wrappers Frida deste dispositivo falham com "TypeError: not a function"
// ao invocar BSa/jvidispatch direto; reflexão Java resolve os mesmos métodos
// que o app chama (JniBridge:1491, X.C1BQ) sem depender da resolução do wrapper.
function findJavaMethod(className, methodName, paramCount) {
  const methods = Java.use(className).class.getDeclaredMethods()
  for (let index = 0; index < methods.length; index += 1) {
    const method = methods[index]
    if (String(method.getName()) !== methodName) continue
    if (method.getParameterTypes().length !== paramCount) continue
    method.setAccessible(true)
    return method
  }
  return null
}

function invokeJniBridgeStatic(methodName, args) {
  const method = findJavaMethod('com.whatsapp.wamsys.JniBridge', methodName, args.length)
  if (!method) throw new Error('native dispatch not found: ' + methodName)
  return method.invoke(null, Java.array('java.lang.Object', args))
}

// Lê byte[] Java via java.lang.reflect.Array: o wrapper Frida de '[B' nem
// sempre expõe .length como número (virava loop vazio e o campo saía como
// string vazia no ambiente — ex.: _gs/_gg/_gi do mapa nativo). O serializador
// oficial omite valores vazios, então '' aqui significa "campo ausente".
function byteArrayWireValue(rawArray) {
  const bytes = Java.cast(rawArray, Java.use('[B'))
  const ArrayClass = Java.use('java.lang.reflect.Array')
  const length = Number(ArrayClass.getLength(bytes))
  if (!Number.isFinite(length) || length <= 0) return ''
  let value = ''
  for (let index = 0; index < length; index += 1) {
    const byte = Number(ArrayClass.getByte(bytes, index)) & 0xff
    const safe = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e ||
      byte === 0x5f || byte === 0x7e
    value += safe ? String.fromCharCode(byte) : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return value
}

// Igual ao invokeJniBridgeStatic, mas embrulha números JS no wrapper Java que
// casa com o tipo declarado do parâmetro (int/long/double/float): o invoke por
// reflexão exige o wrapper exato para desembrulhar primitivos.
function invokeJniBridgeTyped(methodName, args) {
  const method = findJavaMethod('com.whatsapp.wamsys.JniBridge', methodName, args.length)
  if (!method) throw new Error('native dispatch not found: ' + methodName)
  const params = method.getParameterTypes()
  const boxed = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    const typeName = String(params[index].getName())
    if (typeof value === 'number') {
      if (typeName === 'int') boxed.push(Java.use('java.lang.Integer').valueOf(value))
      else if (typeName === 'long') boxed.push(Java.use('java.lang.Long').$new(value))
      else if (typeName === 'float') boxed.push(Java.use('java.lang.Float').$new(value))
      else boxed.push(Java.use('java.lang.Double').$new(value))
    } else {
      boxed.push(value)
    }
  }
  return method.invoke(null, Java.array('java.lang.Object', boxed))
}

function ensureNativeLibLoaded() {
  // O nome BSa existe só no decompilado (renomeado pelo jadx); no dex real o
  // método de load tem outro nome. O que é estável são os métodos NATIVE
  // (nomes JNI): getJNICodeVersion só responde com libwhatsapp carregada.
  const method = findJavaMethod('com.whatsapp.infra.nativelibloader.WhatsAppLibLoader', 'getJNICodeVersion', 0)
  if (!method) throw new Error('getJNICodeVersion not found')
  return method.invoke(null, Java.array('java.lang.Object', []))
}

function classDeclaresApm(cls) {
  const methods = cls.getDeclaredMethods()
  const seen = []
  for (let index = 0; index < methods.length; index += 1) {
    const method = methods[index]
    const params = method.getParameterTypes()
    const args = []
    for (let p = 0; p < params.length; p += 1) args.push(String(params[p].getName()))
    seen.push(String(method.getName()) + '(' + args.join(',') + ')')
    if (String(method.getName()) === 'APm' && params.length === 1 &&
      String(params[0].getName()) === 'java.lang.String') return true
  }
  agentLog('gpia class ' + String(cls.getName()) + ' methods: ' + seen.join(','))
  return false
}

function surveyRuntimeNames() {
  try {
    const Fko = Java.use('X.Fko')
    const cls = Fko.class
    agentLog('X.Fko kind=' + (cls.isInterface() ? 'interface' : 'class') +
      ' super=' + String(cls.getSuperclass() ? cls.getSuperclass().getName() : 'null'))
    classDeclaresApm(cls)
    const ifaces = cls.getInterfaces()
    for (let i = 0; i < ifaces.length; i += 1) {
      agentLog('X.Fko interface[' + i + ']=' + String(ifaces[i].getName()))
      classDeclaresApm(ifaces[i])
    }
  } catch (error) {
    agentLog('X.Fko = MISSING ' + error)
  }
  try {
    const JniBridge = Java.use('com.whatsapp.wamsys.JniBridge')
    const field = JniBridge.class.getDeclaredField('jniCallbacksIJniCallbacksAndroidGpia')
    field.setAccessible(true)
    const instanceField = JniBridge.class.getDeclaredField('INSTANCE')
    instanceField.setAccessible(true)
    const instance = instanceField.get(null)
    const callbacks = instance ? field.get(instance) : null
    if (callbacks) {
      agentLog('gpia callbacks class=' + String(callbacks.getClass().getName()))
      let superCls = callbacks.getClass().getSuperclass()
      while (superCls) {
        agentLog('gpia callbacks super=' + String(superCls.getName()))
        classDeclaresApm(superCls)
        superCls = superCls.getSuperclass()
      }
      classDeclaresApm(callbacks.getClass())
      const ifaces = callbacks.getClass().getInterfaces()
      for (let i = 0; i < ifaces.length; i += 1) {
        agentLog('gpia callbacks interface[' + i + ']=' + String(ifaces[i].getName()))
        classDeclaresApm(ifaces[i])
      }
    } else {
      agentLog('gpia callbacks object is null')
    }
  } catch (error) {
    agentLog('gpia callbacks field missing: ' + error)
  }
}

function stubDefault(returnName) {
  if (returnName === 'void') return undefined
  if (returnName === 'boolean') return false
  if (returnName === 'char') return 0
  if (returnName === 'byte' || returnName === 'short' || returnName === 'int' ||
      returnName === 'long' || returnName === 'float' || returnName === 'double') return 0
  return null
}

function boxedStub(returnName) {
  if (returnName === 'boolean') return Java.use('java.lang.Boolean').$new(false)
  if (returnName === 'byte') return Java.use('java.lang.Byte').$new(0)
  if (returnName === 'short') return Java.use('java.lang.Short').$new(0)
  if (returnName === 'char') return Java.use('java.lang.Character').$new(0)
  if (returnName === 'int') return Java.use('java.lang.Integer').$new(0)
  if (returnName === 'long') return Java.use('java.lang.Long').$new(0)
  if (returnName === 'float') return Java.use('java.lang.Float').$new(0)
  if (returnName === 'double') return Java.use('java.lang.Double').$new(0)
  return null
}

// A interface do callback de gpia muda de nome entre os builds (no estudo do
// Messenger era X.Dj8, com implementador X.Fko; em W4B os nomes obfuscados
// são outros). Resolvemos em runtime: primeiro a própria X.Fko quando é
// interface com APm(String), depois as interfaces dela, e por fim a classe do
// campo jniCallbacksIJniCallbacksAndroidGpia do JniBridge. Sem interface,
// devolvemos null e o chamador usa uma classe solta só com APm(String).
function resolveGpiaCallbackInterfaceName() {
  // 1º: o cast de jnidispatchIOO nomeia a interface real do build em execução.
  const probed = probeCallbackInterfaceViaCast()
  if (probed) {
    agentLog('gpia callback interface resolved by cast probe: ' + probed)
    return probed
  }
  try {
    const Fko = Java.use('X.Fko')
    const fkoClass = Fko.class
    if (fkoClass.isInterface() && classDeclaresApm(fkoClass)) return 'X.Fko'
    const ifaces = fkoClass.getInterfaces()
    for (let index = 0; index < ifaces.length; index += 1) {
      if (classDeclaresApm(ifaces[index])) return String(ifaces[index].getName())
    }
  } catch (error) {
    agentLog('gpia interface resolve via X.Fko failed: ' + error)
  }
  try {
    const JniBridge = Java.use('com.whatsapp.wamsys.JniBridge')
    const field = JniBridge.class.getDeclaredField('jniCallbacksIJniCallbacksAndroidGpia')
    field.setAccessible(true)
    const instanceField = JniBridge.class.getDeclaredField('INSTANCE')
    instanceField.setAccessible(true)
    const instance = instanceField.get(null)
    const callbacks = instance ? field.get(instance) : null
    if (callbacks) {
      const ifaces = callbacks.getClass().getInterfaces()
      for (let index = 0; index < ifaces.length; index += 1) {
        if (classDeclaresApm(ifaces[index])) return String(ifaces[index].getName())
      }
    }
  } catch (error) {
    agentLog('gpia interface resolve via JniBridge callbacks failed: ' + error)
  }
  return null
}

// O Proxy implementa a interface inteira; só o método (String)->void tem
// comportamento real (o nome muda entre builds: APm no estudo, outro no W4B).
function makeGpiaCallbackProxy(onValue) {
  const interfaceName = resolveGpiaCallbackInterfaceName()
  agentLog('gpia callback interface=' + (interfaceName || '(none)'))
  if (!interfaceName) {
    // Sem interface identificada: o dispatch nativo resolve APm(String) pelo
    // nome na classe do objeto; uma classe solta com esse método basta.
    return Java.registerClass({
      name: listenerName('GpiaWrap'),
      methods: {
        APm: {
          returnType: 'void',
          argumentTypes: ['java.lang.String'],
          implementation: function(value) {
            onValue(String(value))
          }
        }
      }
    }).$new()
  }
  const CallbackInterface = Java.use(interfaceName)
  const InvocationHandler = Java.use('java.lang.reflect.InvocationHandler')
  const handler = Java.registerClass({
    name: listenerName('GpiaWrapHandler'),
    implements: [InvocationHandler],
    methods: {
      invoke: {
        returnType: 'java.lang.Object',
        argumentTypes: ['java.lang.Object', 'java.lang.reflect.Method', '[Ljava.lang.Object;'],
        implementation: function(proxy, method, args) {
          const name = String(method.getName())
          const paramTypes = method.getParameterTypes()
          const isDelivery = paramTypes.length === 1 &&
            String(paramTypes[0].getName()) === 'java.lang.String'
          if (isDelivery) {
            agentLog('gpia callback delivered via ' + name)
            onValue(String(args[0]))
            return null
          }
          return boxedStub(String(method.getReturnType().getName()))
        }
      }
    }
  })
  const Proxy = Java.use('java.lang.reflect.Proxy')
  const interfaceClass = CallbackInterface.class
  const loader = interfaceClass.getClassLoader()
  return Proxy.newProxyInstance(
    loader,
    Java.array('java.lang.Class', [interfaceClass]),
    handler.$new()
  )
}

function getWajContextInstance() {
  const JniBridge = Java.use('com.whatsapp.wamsys.JniBridge')
  const field = JniBridge.class.getDeclaredField('INSTANCE')
  field.setAccessible(true)
  const instance = field.get(null)
  if (instance === null) return null
  const method = findJavaMethod('com.whatsapp.wamsys.JniBridge', 'getWajContext', 0)
  if (!method) throw new Error('getWajContext not found')
  return method.invoke(instance, Java.array('java.lang.Object', []))
}

// jnidispatchIOO (nativo -> Java) faz o cast do callback para a interface de
// gpia e engole a ClassCastException no jniBridgeExceptionHandler. Hookamos o
// handler para capturar a mensagem do CCE: ela nomeia o tipo alvo do cast.
function hookJniBridgeExceptionHandler() {
  const JniBridge = Java.use('com.whatsapp.wamsys.JniBridge')
  const field = JniBridge.class.getDeclaredField('jniBridgeExceptionHandler')
  field.setAccessible(true)
  const instanceField = JniBridge.class.getDeclaredField('INSTANCE')
  instanceField.setAccessible(true)
  const instance = instanceField.get(null)
  const handler = instance ? field.get(instance) : null
  if (!handler) {
    agentLog('jni exception handler object is null')
    return
  }
  const cls = handler.getClass()
  const className = String(cls.getName())
  const Handler = Java.use(className)
  const methods = cls.getDeclaredMethods()
  for (let index = 0; index < methods.length; index += 1) {
    const methodName = String(methods[index].getName())
    const overloads = Handler[methodName].overloads
    for (let o = 0; o < overloads.length; o += 1) {
      overloads[o].implementation = function () {
        const parts = []
        for (let a = 0; a < arguments.length; a += 1) {
          const text = String(arguments[a])
          parts.push(text)
          if (text.indexOf('Exception') >= 0 || text.indexOf('cast') >= 0) {
            lastJniHandlerError = text
          }
        }
        agentLog('jni exception handler.' + methodName + '(' + parts.join(', ') + ')')
        return null
      }
    }
  }
  agentLog('jni exception handler hooked: ' + className + ' methods=' + methods.length)
}

// Provoca o cast de jnidispatchIOO com um objeto qualquer; o CCE engolido pelo
// handler revela a interface verdadeira do callback ("cannot be cast to X.Y").
function probeCallbackInterfaceViaCast() {
  lastJniHandlerError = null
  try {
    invokeJniBridgeStatic('jnidispatchIOO', [
      Java.use('java.lang.Integer').$new(1),
      Java.use('java.lang.String').$new('probe'),
      Java.use('java.lang.Object').$new()
    ])
  } catch (probeError) {
    agentLog('gpia cast probe threw: ' + probeError)
  }
  const message = lastJniHandlerError
  if (!message) {
    agentLog('gpia cast probe: no error captured')
    return null
  }
  agentLog('gpia cast probe error: ' + message)
  const patterns = [
    /cast to '?([A-Za-z0-9_.$]+)'?/,
    /to ([A-Za-z0-9_.$]+)/,
    /interface method '[^']* ([A-Za-z0-9_.$]+)\./
  ]
  for (let index = 0; index < patterns.length; index += 1) {
    const match = message.match(patterns[index])
    if (match && match[1] && match[1].indexOf('.') >= 0) return match[1]
  }
  return null
}

function percentDecodeQuery(value) {
  return decodeURIComponent(value.replace(/\+/g, ' '))
}

function percentEncodeOfficial(value) {
  // AbstractC26306BoO.A00: upper-case percent encoding, A-Z a-z 0-9 - . _ ~ safe.
  return String(value).replace(/[^A-Za-z0-9\-._~]/g, function (character) {
    const hex = character.charCodeAt(0).toString(16).toUpperCase()
    return '%' + (hex.length < 2 ? '0' + hex : hex)
  })
}

function base64ToBytes(value) {
  const Base64 = Java.use('android.util.Base64')
  const decoded = Base64.decode(value, 2) // Base64.NO_WRAP
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded[index] < 0 ? decoded[index] + 256 : decoded[index]
  }
  return bytes
}

function bytesToBase64(bytes) {
  const Base64 = Java.use('android.util.Base64')
  return String(Base64.encodeToString(javaByteArray(bytes), 2))
}

function makeKeyAttestation(challengeBytes) {
  const KeyStore = Java.use('java.security.KeyStore')
  const KeyPairGenerator = Java.use('java.security.KeyPairGenerator')
  const SpecBuilder = Java.use('android.security.keystore.KeyGenParameterSpec$Builder')
  const JavaDate = Java.use('java.util.Date')
  const ByteBuffer = Java.use('java.nio.ByteBuffer')
  const SecureRandom = Java.use('java.security.SecureRandom')

  const keyStore = KeyStore.getInstance('AndroidKeyStore')
  keyStore.load(null)

  keyStoreSequence += 1
  const alias = 'infinite_api_pairing_' + Date.now() + '_' + keyStoreSequence
  const notAfter = JavaDate.$new(Date.now() + 365 * 24 * 60 * 60 * 1000)
  const builder = SpecBuilder.$new(alias, 4) // PURPOSE_SIGN
  const digests = Java.array('java.lang.String', ['SHA-256', 'SHA-512'])
  builder.setDigests.overload('[Ljava.lang.String;').call(builder, digests)
  builder.setUserAuthenticationRequired(false)
  builder.setCertificateNotAfter(notAfter)

  // Official companion registration binds the KeyStore challenge to
  // epoch-seconds || 0x1f || companion static identity public key.
  const timestamp = Math.floor(Date.now() / 1000)
  const timestampWords = BigInt(timestamp).toString(16).padStart(16, '0')
  const timestampBytes = new Uint8Array(8)
  for (let index = 0; index < 8; index += 1) {
    timestampBytes[index] = parseInt(timestampWords.slice(index * 2, index * 2 + 2), 16)
  }
  const challenge = new Uint8Array(8 + 1 + challengeBytes.length)
  challenge.set(timestampBytes, 0)
  challenge[8] = 31
  challenge.set(challengeBytes, 9)
  builder.setAttestationChallenge(javaByteArray(challenge))

  try {
    builder.setDevicePropertiesAttestationIncluded(true)
  } catch (error) {
    agentLog('device-properties attestation unavailable: ' + error)
  }

  const generator = KeyPairGenerator.getInstance('EC', 'AndroidKeyStore')
  try {
    generator.initialize.overload('java.security.spec.AlgorithmParameterSpec').call(generator, builder.build())
    generator.generateKeyPair()
  } catch (error) {
    // Official WhatsApp does this exact fallback when the vendor keymaster
    // rejects device-properties attestation (common on emulators/AOSP keys).
    agentLog('device-properties key generation failed, retrying without it: ' + error)
    builder.setDevicePropertiesAttestationIncluded(false)
    generator.initialize.overload('java.security.spec.AlgorithmParameterSpec').call(generator, builder.build())
    generator.generateKeyPair()
  }

  try {
    const certificates = keyStore.getCertificateChain(alias)
    if (!certificates) throw new Error('AndroidKeyStore returned an empty certificate chain')
    const encoded = []
    for (let index = certificates.length - 1; index >= 0; index -= 1) {
      encoded.push(certificates[index].getEncoded())
    }
    let size = 0
    for (const bytes of encoded) size += bytes.length
    const chain = new Uint8Array(size)
    let offset = 0
    for (const bytes of encoded) {
      chain.set(bytes, offset)
      offset += bytes.length
    }
    if (chain.byteLength === 0) throw new Error('AndroidKeyStore returned an empty attestation')
    return chain
  } finally {
    try {
      keyStore.deleteEntry(alias)
    } catch (error) {
      agentLog('temporary pairing key cleanup failed: ' + error)
    }
  }
}

function requestStandardIntegrity(requestHash, cloudProjectNumber) {
  return new Promise(function(resolve, reject) {
    Java.perform(function() {
      try {
        const Factory = Java.use('com.google.android.play.core.integrity.IntegrityManagerFactory')
        const StandardManager = Java.use('com.google.android.play.core.integrity.StandardIntegrityManager')
    const PrepareRequest = Java.use('com.google.android.play.core.integrity.StandardIntegrityManager$PrepareIntegrityTokenRequest')
    const TokenRequest = Java.use('com.google.android.play.core.integrity.StandardIntegrityManager$StandardIntegrityTokenRequest')

        const manager = Factory.createStandard(Java.use('android.app.ActivityThread').currentApplication())
        if (!manager) throw new Error('StandardIntegrityManager is unavailable')

        const prepareBuilder = PrepareRequest.builder()
        prepareBuilder.setCloudProjectNumber(Number(cloudProjectNumber || 293955441834))
        attachTaskListeners(
          manager.prepareIntegrityToken(prepareBuilder.build()),
          'StandardPrepare',
          function(prepareResponse) {
            try {
              const tokenBuilder = TokenRequest.builder()
              tokenBuilder.setRequestHash(requestHash)
              const providerClass = Java.use(prepareResponse.$className)
              const reflectedMethods = providerClass.class.getDeclaredMethods()
              let requestMethod
              for (let methodIndex = 0; methodIndex < reflectedMethods.length; methodIndex += 1) {
                if (String(reflectedMethods[methodIndex].getName()) === 'request') {
                  requestMethod = reflectedMethods[methodIndex]
                  break
                }
              }
              if (!requestMethod) throw new Error('Standard Integrity provider request method was not found')
              const requestParameter = requestMethod.getParameterTypes()[0]
              const requestParameterClass = Java.use(String(requestParameter.getName()))
              const tokenRequest = Java.cast(tokenBuilder.build(), requestParameterClass)
              const invokeArguments = Java.array('java.lang.Object', [tokenRequest])
              const Task = Java.use('com.google.android.gms.tasks.Task')
              const tokenTask = Java.cast(
                requestMethod.invoke(prepareResponse, invokeArguments),
                Task
              )
              attachTaskListeners(
                tokenTask,
                'StandardToken',
                function(tokenResponse) {
                  try {
                    const tokenResponseClass = Java.use(tokenResponse.$className)
                    const tokenReflectedMethods = tokenResponseClass.class.getDeclaredMethods()
                    let tokenMethod
                    for (let methodIndex = 0; methodIndex < tokenReflectedMethods.length; methodIndex += 1) {
                      const method = tokenReflectedMethods[methodIndex]
                      const returnType = String(method.getReturnType().getName())
                      const parameterCount = method.getParameterTypes().length
                      if (method.getName() === 'token' && returnType === 'java.lang.String' && parameterCount === 0) {
                        tokenMethod = method
                        break
                      }
                    }
                    if (!tokenMethod) throw new Error('Standard Integrity token method was not found')
                    const token = String(tokenMethod.invoke(tokenResponse, Java.array('java.lang.Object', [])))
                    if (!token || token.length < 20) throw new Error('Standard Integrity returned an empty token')
                    resolve(token)
                  } catch (error) { reject(error) }
                },
                reject
              )
            } catch (error) { reject(error) }
          },
          reject
        )
      } catch (error) { reject(error) }
    })
  })
}

function attachTaskListeners(task, prefix, onResult, reject) {
  const success = makeSuccessListener(prefix, onResult)
  const failure = makeFailureListener(prefix, reject)
  task.addOnSuccessListener(success.$new())
  task.addOnFailureListener(failure.$new())
}

function appWrapIntegrityToken(token) {
  // Espelha o caminho de registro (F43FA...$2): a camada nativa wamsys recebe o
  // token de integridade e devolve pelo callback X.Dj8.APm a string oficial do
  // parâmetro `gpia` (1088 chars base64std na captura). Só o APK em execução
  // consegue produzir esse blob; nunca fabricamos um valor.
  return new Promise(function(resolve, reject) {
    Java.perform(function() {
      try {
        agentLog('gpia wrap: start')
        surveyRuntimeNames()
        hookJniBridgeExceptionHandler()
        const libVersion = ensureNativeLibLoaded()
        agentLog('gpia wrap: native lib ready version=' + libVersion)
        const wajContext = getWajContextInstance()
        if (!wajContext) throw new Error('waj context unavailable')
        agentLog('gpia wrap: waj context ready')
        const appContext = Java.use('android.app.ActivityThread').currentApplication()
        let settled = false
        const timer = setTimeout(function() {
          if (settled) return
          settled = true
          reject(new Error('gpia native wrap timed out'))
        }, 8000)
        const callback = makeGpiaCallbackProxy(function(value) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        })
        agentLog('gpia wrap: callback proxy ready')
        // Priming oficial (F43FA...$2 l.65-72): jvidispatchIIIIDOOO(gate 12965
        // ? 19 : 0, 62949436L, 855397460L, 796.6509679599703d, app,
        // wajContext, byte[20]) roda ANTES do wrap; sem ele o blob sai 64
        // bytes curto (1004 chars vs 1088 da captura oficial). Ex0.A05 e
        // Ex0.A06 devolvem o mesmo JniBridge.INSTANCE, então o mesmo wajContext
        // serve aos dois dispatches.
        var primingFlag = 0
        try {
          // X.Dla = runtime de AbstractC31165Dla (renomeado pelo jadx);
          // A0M() devolve o singleton de gates X.0Cf (C02710Cf).
          var gates = Java.use('X.Dla').A0M()
          primingFlag = gates.A0y(12965) ? 19 : 0
          agentLog('gpia priming gate 12965 flag=' + primingFlag)
        } catch (gateError) {
          agentLog('gpia priming gate unavailable, flag stays 0: ' + gateError)
        }
        agentLog('gpia wrap: dispatching native priming')
        invokeJniBridgeTyped('jvidispatchIIIIDOOO', [
          primingFlag,
          62949436,
          855397460,
          796.6509679599703,
          appContext,
          wajContext,
          Java.array('byte', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        ])
        agentLog('gpia wrap: native priming dispatched')
        agentLog('gpia wrap: dispatching native wrap')
        // F43FA...$2 chama jvidispatchIIDOOOO(errorCode, 0.0, token, app,
        // callback, wajContext); no caminho de sucesso errorCode=0.
        invokeJniBridgeStatic('jvidispatchIIDOOOO', [
          Java.use('java.lang.Long').$new(0),
          Java.use('java.lang.Double').$new(0.0),
          Java.use('java.lang.String').$new(String(token)),
          appContext,
          callback,
          wajContext
        ])
        agentLog('gpia wrap: native wrap dispatched')
      } catch (error) {
        reject(error)
      }
    })
  })
}

function computeOfficialUserAgent() {
  // Mirrors X.C10170d3.A00 for W4B. It intentionally uses the real Build
  // values; no device properties are fabricated or cached across reboots.
  const sanitize = value => String(value).replace(/[^,\.\w\-\(\)]/g, '_')
  const Build = Java.use('android.os.Build')
  const BuildVersion = Java.use('android.os.Build$VERSION')
  const version = sanitize(BuildVersion.RELEASE.value)
  const manufacturer = sanitize(Build.MANUFACTURER.value)
  const model = sanitize(Build.MODEL.value)
  return 'WhatsApp/2.26.36.72 SMBA/' + version +
    ' Device/' + manufacturer + '-' + model
}

function collectRegistrationEnvironment(cloudProjectNumber) {
  return new Promise(function(resolve, reject) {
    Java.perform(function() {
      try {
        const appContext = Java.use('android.app.ActivityThread').currentApplication()
        if (!appContext) throw new Error('Android application context is unavailable')

        const environment = {}
        const TelephonyManager = Java.use('android.telephony.TelephonyManager')
        const telephony = Java.cast(appContext.getSystemService('phone'), TelephonyManager)
        const networkOperator = String(telephony.getNetworkOperator() || '')
        const simOperator = String(telephony.getSimOperator() || '')
        if (networkOperator.length >= 3) {
          environment.mcc = networkOperator.substring(0, 3)
          environment.mnc = networkOperator.substring(3)
        }
        if (simOperator.length >= 3) {
          environment.sim_mcc = simOperator.substring(0, 3)
          environment.sim_mnc = simOperator.substring(3)
        }
        if (environment.mcc === undefined || environment.sim_mcc === undefined) {
          // Fallback 1: registros reais de assinatura ativa. Sem SIM/rádio os
          // campos ficam ausentes — nunca inventamos operadora.
          try {
            const SubscriptionManager = Java.use('android.telephony.SubscriptionManager')
            const subscriptionManager = Java.cast(
              appContext.getSystemService('telephony_subscription'), SubscriptionManager
            )
            const activeList = subscriptionManager ? subscriptionManager.getActiveSubscriptionInfoList() : null
            if (activeList && activeList.size() > 0) {
              const info = Java.cast(activeList.get(0), Java.use('android.telephony.SubscriptionInfo'))
              const subMcc = String(info.getMccString ? info.getMccString() : '')
              const subMnc = String(info.getMncString ? info.getMncString() : '')
              if (subMcc.length >= 3) {
                if (environment.mcc === undefined) {
                  environment.mcc = subMcc
                  environment.mnc = subMnc
                }
                if (environment.sim_mcc === undefined) {
                  environment.sim_mcc = subMcc
                  environment.sim_mnc = subMnc
                }
              }
            }
          } catch (subscriptionError) {
            agentLog('subscription fallback unavailable: ' + subscriptionError)
          }
        }

        environment.sim_type = telephony.getSimState() === 1 ? 0 : 1
        const SettingsGlobal = Java.use('android.provider.Settings$Global')
        environment.airplane_mode_type = SettingsGlobal.getInt(
          appContext.getContentResolver(), 'airplane_mode_on', 0
        ) !== 0 ? 1 : 0
        const signalStrength = telephony.getSignalStrength()
        environment.cellular_strength = signalStrength ? signalStrength.getLevel() : 5
        environment.roaming_type = telephony.isNetworkRoaming() ? 1 : 0

        // Install source is system-owned state, not an APK property. Mirror
        // X.KU2.CBW -> X.C0BJ.A2O without fabricating a value when absent.
        try {
          const PackageManager = Java.use('android.content.pm.PackageManager')
          const packageManager = Java.cast(appContext.getPackageManager(), PackageManager)
          const packageName = String(appContext.getPackageName())
          const installer = packageManager.getInstallerPackageName(packageName)
          if (installer !== null) environment.installer_package = String(installer)

          if (parseInt(Java.use('android.os.Build$VERSION').SDK_INT.value, 10) >= 34) {
            const sourceInfo = packageManager.getInstallSourceInfo(packageName)
            const rawPackageSource = Number(sourceInfo.getPackageSource())
            const packageSourceMap = {
              0: 'unspecified',
              1: 'other',
              2: 'store',
              3: 'local_file',
              4: 'downloaded_file'
            }
            environment.package_source = packageSourceMap[rawPackageSource] ||
              ('unknown_' + rawPackageSource)
            const installingPackage = sourceInfo.getInstallingPackageName()
            if (installingPackage !== null) {
              environment.installing_package = String(installingPackage)
            }
            const initiatingPackage = sourceInfo.getInitiatingPackageName()
            if (initiatingPackage !== null) {
              environment.initiating_package = String(initiatingPackage)
            }
          }
        } catch (error) {
          agentLog('install source unavailable: ' + error)
        }

        const ConnectivityManager = Java.use('android.net.ConnectivityManager')
        const connectivity = Java.cast(appContext.getSystemService('connectivity'), ConnectivityManager)
        const activeNetwork = connectivity.getActiveNetwork()
        const capabilities = activeNetwork ? connectivity.getNetworkCapabilities(activeNetwork) : null
        const NetworkCapabilities = Java.use('android.net.NetworkCapabilities')
        environment.network_radio_type = capabilities && capabilities.hasTransport(
          NetworkCapabilities.TRANSPORT_WIFI.value
        ) ? 1 : 0

        const ActivityManager = Java.use('android.app.ActivityManager')
        const activityManager = Java.cast(appContext.getSystemService('activity'), ActivityManager)
        const memoryInfo = Java.use('android.app.ActivityManager$MemoryInfo').$new()
        activityManager.getMemoryInfo(memoryInfo)
        const totalMemory = Number(memoryInfo.totalMem.value)
        environment.device_ram = Number.isFinite(totalMemory)
          ? Math.round((totalMemory / (1024 * 1024 * 1024)) * 100) / 100
          : undefined
        environment.pid = Java.use('android.os.Process').myPid()
        environment.rc = 0
        environment.hasinrc = Java.use('java.io.File').$new(
          appContext.getFilesDir(), 'rc2'
        ).exists() ? 1 : 0

        // FMA.A09 lê exatamente estas duas preferências do app para os campos
        // education_screen_displayed / prefer_sms_over_flash. Somente valores
        // realmente presentes entram no ambiente.
        try {
          const Context = Java.use('android.content.Context')
          const prefsCandidates = [
            appContext.getSharedPreferences('com.whatsapp.w4b_preferences', 0),
            Java.use('android.preference.PreferenceManager').getDefaultSharedPreferences(appContext)
          ]
          for (let prefsIndex = 0; prefsIndex < prefsCandidates.length; prefsIndex += 1) {
            const prefs = prefsCandidates[prefsIndex]
            if (!prefs) continue
            if (environment.education_screen_displayed === undefined &&
                prefs.contains('pref_flash_call_education_screen_displayed')) {
              environment.education_screen_displayed =
                prefs.getBoolean('pref_flash_call_education_screen_displayed', false)
            }
            if (environment.prefer_sms_over_flash === undefined &&
                prefs.contains('pref_prefer_sms_over_flash')) {
              environment.prefer_sms_over_flash =
                prefs.getBoolean('pref_prefer_sms_over_flash', false)
            }
          }
        } catch (prefsError) {
          agentLog('registration preferences unavailable: ' + prefsError)
        }

        // COP.A0T passes this native map directly into CJT.A07. Return the
        // values verbatim; never synthesize a missing Google payload.
        try {
          // X.C1BQ sempre carrega a lib nativa (BSa) antes de qualquer
          // jvidispatch; sem isso o mapa nativo volta vazio.
          ensureNativeLibLoaded()
          const wajContext = getWajContextInstance()
          if (wajContext) {
            invokeJniBridgeStatic('jvidispatchIOO', [
              Java.use('java.lang.Integer').$new(7), appContext, wajContext
            ])
          }
          const nativeMap = wajContext ? invokeJniBridgeStatic('jvidispatchOOO', [
            Java.use('java.lang.Integer').$new(16), appContext, wajContext
          ]) : null
          if (nativeMap) {
            const map = Java.cast(nativeMap, Java.use('java.util.Map'))
            const iterator = map.entrySet().iterator()
            while (iterator.hasNext()) {
              const entry = Java.cast(iterator.next(), Java.use('java.util.Map$Entry'))
              const key = String(entry.getKey())
              const rawValue = entry.getValue()
              if (rawValue === null) continue
              if (rawValue.$className !== '[B') {
                const text = String(rawValue)
                if (text.length > 0) environment[key] = text
                continue
              }
              const value = byteArrayWireValue(rawValue)
              if (value.length > 0) environment[key] = value
            }
          }
        } catch (nativeError) {
          agentLog('registration environment native map unavailable: ' + nativeError)
        }

        // O mapa CJT do app é exatamente o que o serializador oficial escreve
        // no fio (recaptcha, mistyped, hasav, client_metrics, feo2_query_status,
        // simnum, _gi, _gg...). Mesclamos as entradas cruas para o ambiente sair
        // 1:1 com o que o app enviaria; o gpia fica com o token recém-gerado.
        try {
          const knownEnvKeys = [
            '_gs', '_ga', 'aid', '_gp', '_gg', '_ge', '_gi',
            'mcc', 'mnc', 'sim_mcc', 'sim_mnc', 'sim_type', 'airplane_mode_type',
            'cellular_strength', 'roaming_type', 'network_radio_type', 'device_ram',
            'pid', 'rc', 'hasinrc', 'hasav', 'db', 'mistyped', 'simnum', 'recaptcha',
            'prefer_sms_over_flash', 'client_metrics', 'education_screen_displayed',
            'feo2_query_status', 'reason', 'sim_state', 'offline_ab'
          ]
          const knownSet = {}
          for (let knownIndex = 0; knownIndex < knownEnvKeys.length; knownIndex += 1) {
            knownSet[knownEnvKeys[knownIndex]] = true
          }
          const blobSet = { _gs: true, _ga: true, aid: true, _gp: true, _gg: true, _ge: true, _gi: true }
          const MapClass = Java.use('java.util.Map')
          const EntryClass = Java.use('java.util.Map$Entry')
          const mergeCjtMap = function (mapObject) {
            if (!mapObject) return 0
            let merged = 0
            const map = Java.cast(mapObject, MapClass)
            const iterator = map.entrySet().iterator()
            while (iterator.hasNext()) {
              const entry = Java.cast(iterator.next(), EntryClass)
              const key = String(entry.getKey())
              if (!knownSet[key]) continue
              const rawValue = entry.getValue()
              if (rawValue === null) continue
              if (rawValue.$className === '[B') {
                if (!blobSet[key]) continue
                const encoded = byteArrayWireValue(rawValue)
                if (encoded.length === 0) continue
                environment[key] = encoded
                merged += 1
                continue
              }
              const text = String(rawValue)
              if (text.length === 0 && key !== 'reason') continue
              environment[key] = text
              merged += 1
            }
            return merged
          }
          let mergedKeys = 0
          for (let trackedIndex = 0; trackedIndex < trackedCjtInstances.length; trackedIndex += 1) {
            try {
              const mapField = trackedCjtInstances[trackedIndex].ref.A00
              if (mapField !== undefined && mapField !== null) mergedKeys += mergeCjtMap(mapField.value)
            } catch (trackedError) {
              agentLog('CJT env merge failed: ' + trackedError)
            }
          }
          if (mergedKeys === 0) {
            Java.choose('X.CJT', {
              onInstance: function (instance) {
                try {
                  const mapField = instance.A00
                  if (mapField !== undefined && mapField !== null) mergedKeys += mergeCjtMap(mapField.value)
                } catch (scanError) {}
              },
              onComplete: function () {}
            })
          }
          agentLog('registration environment CJT merged=' + mergedKeys + ' total=' + Object.keys(environment).length)
        } catch (cjtError) {
          agentLog('registration environment CJT merge unavailable: ' + cjtError)
        }

        // requestHash oficial (C36183FvX case 5) = Base64 std sem pad/quebra
        // (flag 3) da MESMA authkey estática que o request injeta no corpo
        // (metadata.A0I(); X.058/X.BqN.A01 → X.1Bt). Sem hash o GMS entrega um
        // token não vinculado ao cliente e o wrap sai 64 bytes curto.
        var gpiaRequestHash = ''
        try {
          var LazyGpia = Java.use('X.058')
          var HolderGpia = Java.use('X.BqN')
          var MetadataGpia = Java.use('X.1Bt')
          var metadataGpia = Java.cast(LazyGpia.A02(HolderGpia.A01.value), MetadataGpia)
          var Base64Gpia = Java.use('android.util.Base64')
          gpiaRequestHash = String(Base64Gpia.encodeToString(metadataGpia.A0I(), 3))
          agentLog('gpia requestHash ready length=' + gpiaRequestHash.length)
        } catch (hashError) {
          agentLog('gpia requestHash unavailable: ' + hashError)
        }

        requestStandardIntegrity(gpiaRequestHash, cloudProjectNumber).then(function(rawToken) {
          return appWrapIntegrityToken(rawToken).then(function(wrapped) {
            agentLog('gpia native wrap ready length=' + wrapped.length +
              ' prefix=' + wrapped.slice(0, 12))
            environment.gpia = wrapped
          }, function(wrapError) {
            agentLog('gpia native wrap unavailable, raw standard token kept: ' + wrapError)
            environment.gpia = rawToken
          })
        }).then(function() {
          resolve(environment)
        }, reject)
      } catch (error) { reject(error) }
    })
  })
}

rpc.exports = {
  ping: function() {
    let result
    Java.perform(function() {
      const ActivityThread = Java.use('android.app.ActivityThread')
      if (!ActivityThread.currentApplication()) throw new Error('Android application context is unavailable')
      result = 'ok'
    })
    return result
  },

  getOfficialUserAgent: function() {
    let result
    Java.performNow(function() {
      result = computeOfficialUserAgent()
    })
    return result
  },

  restartTarget: function() {
    Java.perform(function() {
      const Process = Java.use('android.os.Process')
      Process.killProcess(Process.myPid())
    })
  },

  requestNonce: function(nonce, cloudProjectNumber) {
    return new Promise(function(resolve, reject) {
      Java.perform(function() {
        try {
          if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('nonce is required')

          const ActivityThread = Java.use('android.app.ActivityThread')
          const context = ActivityThread.currentApplication()
          if (!context) throw new Error('Android application context is unavailable')

          const Factory = Java.use('com.google.android.play.core.integrity.IntegrityManagerFactory')
          const Request = Java.use('com.google.android.play.core.integrity.IntegrityTokenRequest')
          const TokenResponse = Java.use('com.google.android.play.core.integrity.IntegrityTokenResponse')
          const manager = Factory.create(context)
          if (!manager) throw new Error('IntegrityManager is unavailable')

          const projectNumber = Number(cloudProjectNumber || 293955441834)
          const requestBuilder = Request.builder()
          requestBuilder.setNonce(nonce)
          requestBuilder.setCloudProjectNumber(projectNumber)
          const integrityRequest = requestBuilder.build()

          agentLog('requesting integrity token for cloud project ' + projectNumber)
          const tokenTask = manager.requestIntegrityToken(integrityRequest)
          attachTaskListeners(
            tokenTask,
            'Token',
            function(response) {
              try {
                if (!response) throw new Error('Play Integrity returned an empty response')
                const tokenResponse = Java.cast(response, TokenResponse)
                const jws = String(tokenResponse.token())
                if (!jws || jws.length < 20) throw new Error('Play Integrity returned an empty token')
                agentLog('captured classic integrity JWE length ' + jws.length)
                resolve(jws)
              } catch (error) {
                reject(error)
              }
            },
            reject
          )
        } catch (error) {
          reject(error)
        }
      })
    })
  }
  ,

  requestPairingMaterial: function(challengeBase64, cloudProjectNumber) {
    return new Promise(function(resolve, reject) {
      Java.perform(function() {
        try {
          if (typeof challengeBase64 !== 'string' || challengeBase64.length === 0) {
            throw new Error('pairing challenge is required')
          }
          const challenge = base64ToBytes(challengeBase64)
          if (challenge.length === 0) throw new Error('pairing challenge is empty')
          const keyAttestation = makeKeyAttestation(challenge)
          const requestHash = bytesToBase64(challenge)
          const keyAttestationBase64 = bytesToBase64(keyAttestation)
          const packageName = contextPackageName()
          requestStandardIntegrity(requestHash, cloudProjectNumber).then(function(gpia) {
            resolve({
              keyAttestationBase64: keyAttestationBase64,
              gpia: gpia,
              clientAppId: packageName
            })
          }, reject)
        } catch (error) { reject(error) }
      })
    })
  }
  ,

  collectRegistrationEnvironment: function(cloudProjectNumber) {
    return collectRegistrationEnvironment(cloudProjectNumber)
  }
  ,

  requestRegistrationStep: function(endpoint, registrationType, body) {
    // Execute the official W4B registration body builder in the target process.
    // The private attestation key never leaves AndroidKeyStore.
    return new Promise(function(resolve, reject) {
      Java.perform(function() {
        try {
          var Base64 = Java.use('android.util.Base64')
          if (typeof body !== 'string' || body.length === 0) throw new Error('registration body is required')

          // The official `token` param is an app-fingerprint HMAC computed by
          // X.Mh2.A01 (jadx C50300Mh2) from the APK signature, classes.dex
          // digest and the national number keyed through the logo resource.
          // The motor cannot reproduce it; compute it inside the real APK and
          // replace the value in the query, preserving insertion order.
          var bodyForWire = body
          var inMatch = /(?:^|&)in=([^&]+)/.exec(body)
          var loginMatch = /(?:^|&)login=([^&]+)/.exec(body)
          var tokenNumber = null
          if (registrationType === 1 && loginMatch) {
            // The type-1 (WA_TWO_FA) wire drops cc/in and carries the number
            // inside `login`; the token is still keyed on those digits.
            tokenNumber = percentDecodeQuery(loginMatch[1]).split('@')[0].split(':')[0]
          } else if (inMatch) {
            tokenNumber = percentDecodeQuery(inMatch[1])
          } else if (loginMatch) {
            tokenNumber = percentDecodeQuery(loginMatch[1]).split('@')[0].split(':')[0]
          }
          if (tokenNumber && !/^[0-9]+$/.test(tokenNumber)) tokenNumber = null
          if (tokenNumber) {
            var ActivityThread = Java.use('android.app.ActivityThread')
            var appContext = ActivityThread.currentApplication()
            if (!appContext) throw new Error('Android application context is unavailable')
            var BpY = Java.use('X.BpY')
            var Mh2 = Java.use('X.Mh2')
            var fingerprint = Java.cast(BpY.A00.value, Mh2)
            var officialToken = fingerprint.A01(appContext, tokenNumber)
            if (!officialToken || officialToken.length === 0) throw new Error('official registration token is empty')
            bodyForWire = body.replace(/(^|&)token=[^&]*/, '$1token=' + percentEncodeOfficial(officialToken))
            agentLog('official registration token ready length=' + officialToken.length +
              ' type=' + (registrationType || 0))
          }

          agentLog('raw body for wire: ' + bodyForWire)

          // Environment and Google fields are collected once by
          // collectRegistrationEnvironment and inserted by the motor builder at
          // the exact captured /v2/code positions. Do not append defaults here.

          // X.BqN owns lazy singletons for X.1Bv (native body signer) and
          // X.1Bt (registration key attestation metadata).
          var Lazy = Java.use('X.058')
          var Holder = Java.use('X.BqN')
          var SignerClass = Java.use('X.1Bv')
          var MetadataClass = Java.use('X.1Bt')
          var signer = Java.cast(Lazy.A02(Holder.A00.value), SignerClass)
          var metadata = Java.cast(Lazy.A02(Holder.A01.value), MetadataClass)
          if (!signer.A06()) throw new Error('native key attestation is disabled by remote config')

          // O `authkey` do corpo É a chave estática do APK (metadata.A0I()) e
          // são os mesmos bytes que a chain assa como challenge. Substituímos o
          // valor do builder pelo oficial para o vínculo atestação↔authkey
          // fechar 1:1 (base64url sem padding = flag 11, como o builder).
          var officialAuthkey = String(Base64.encodeToString(metadata.A0I(), 11))
          bodyForWire = bodyForWire.replace(/(^|&)authkey=[^&]*/, '$1authkey=' + officialAuthkey)
          agentLog('official authkey injected length=' + officialAuthkey.length)

          var JavaString = Java.use('java.lang.String')
          var plainBody = JavaString.$new(bodyForWire).getBytes('UTF-8')

          var finalBody
          var encrypted = false
          // RetryingHttpClient (smali 2235847-2235869) signs the payload that
          // actually goes on the wire: the base64 envelope string when the
          // encryption succeeds, the plain query string in the fallback. The
          // A07 metadata argument is `metadata.A0I()`, never the keychain.
          var payloadToSign
          try {
            var Avp = Java.use('X.Avp')
            var Avw = Java.use('X.Avw')
            var Avo = Java.use('X.Avo')
            var Avx = Java.use('X.Avx')
            var BpZ = Java.use('X.BpZ')
            var ephemeral = Java.cast(Avp.A01(), Avw)
            var ephemeralPrivate = ephemeral.A00.value
            var ephemeralPublic = ephemeral.A01.value
            var serverPublic = Avo.$new(BpZ.A00.value, 5)
            var aesKey = Avp.A0A(ephemeralPrivate, serverPublic)

            var Cipher = Java.use('javax.crypto.Cipher')
            var SecretKeySpec = Java.use('javax.crypto.spec.SecretKeySpec')
            var GCMParameterSpec = Java.use('javax.crypto.spec.GCMParameterSpec')
            // W4B 2.26.36.72 creates a 12-byte array and passes it directly to
            // GCMParameterSpec without filling it. Keep the zero IV exactly;
            // a random IV makes the server-side decrypt fail and surfaces as
            // missing_param for the first required body parameter.
            var iv = new Array(12).fill(0)
            var ivBytes = javaByteArray(iv)
            var cipher = Cipher.getInstance('AES/GCM/NoPadding')
            cipher.init(1, SecretKeySpec.$new(aesKey, 'AES'), GCMParameterSpec.$new(128, ivBytes))
            var cipherText = cipher.doFinal(plainBody)

            var ByteArrayOutputStream = Java.use('java.io.ByteArrayOutputStream')
            var combined = ByteArrayOutputStream.$new()
            var publicHeader = ephemeralPublic.A00()
            // RetryingHttpClient (smali line 2235833) copies range [1, len):
            // the leading 0x05 Curve type byte is stripped before the
            // ciphertext concatenation. Sending the full 33-byte header makes
            // the server-side decrypt fail and surfaces as missing_param.
            combined.write(publicHeader, 1, publicHeader.length - 1)
            combined.write(cipherText, 0, cipherText.length)
            var encryptedText = String(Base64.encodeToString(combined.toByteArray(), 11))
            payloadToSign = JavaString.$new(encryptedText).getBytes('UTF-8')
            // Nomes EXATOS do envelope: maiúsculos (CDw.A05="ENC", CDw.A09="H",
            // decodificados do XOR 0x12 em CDw.1.smali). Minúsculo faz o servidor
            // não achar o envelope e responder missing_param.
            finalBody = 'ENC=' + encryptedText
            encrypted = true
          } catch (encryptionError) {
            // This is also the APK fallback when RegistrationEncryption fails.
            agentLog('official registration encryption unavailable, using signed fallback: ' + encryptionError)
            payloadToSign = plainBody
            finalBody = bodyForWire
          }

          var signature = signer.A07(payloadToSign, metadata.A0I())
          if (!signature || signature.length === 0) throw new Error('native registration signing failed')
          // URL_SAFE | NO_WRAP | NO_PADDING, exactly as the APK body builder.
          // Assinatura vai como `H=` (maiúsculo, CDw.A09) logo após o envelope.
          var signatureText = String(Base64.encodeToString(signature, 11))
          finalBody = finalBody + '&H=' + signatureText

          // Official order: sign first, build the attestation chain for the
          // Authorization header afterwards (smali 2235886-2235893).
          var keyChain = signer.A03(signer, Java.use('java.lang.Integer').valueOf(1), metadata.A0I())
          if (!keyChain || keyChain.length === 0) throw new Error('native key attestation chain is empty')

          var authorization = String(Base64.encodeToString(keyChain, 2)) // NO_WRAP
          agentLog('official registration material ready endpoint=' + endpoint +
            ' encrypted=' + encrypted +
            ' inputBytes=' + plainBody.length +
            ' outputBytes=' + finalBody.length +
            ' chainBytes=' + keyChain.length)

          // RetryingHttpClient sends requests through WaHttpUrlConnection and
          // sets the WhatsApp user agent (X.C10170d3.A00). A bare Java user
          // agent is not accepted by the registration platform selector.
          var officialUserAgent
          try {
            officialUserAgent = computeOfficialUserAgent()
            agentLog('official registration user-agent ready length=' + officialUserAgent.length)
          } catch (userAgentError) {
            agentLog('official registration user-agent unavailable: ' + userAgentError)
          }

          // Execute the actual HTTP request from inside the APK process.
          // This ensures the TLS fingerprint, User-Agent and all connection
          // properties match the official client exactly.
          var targetUrl = 'https://v.whatsapp.net' + endpoint
          agentLog('executing HTTP request from APK: ' + targetUrl)
          var HttpsURLConnection = Java.use('javax.net.ssl.HttpsURLConnection')
          var URL = Java.use('java.net.URL')
          var urlObj = URL.$new(targetUrl)
          var conn = urlObj.openConnection()
          var httpsConn = Java.cast(conn, HttpsURLConnection)
          httpsConn.setRequestMethod('POST')
          httpsConn.setDoOutput(true)
          httpsConn.setConnectTimeout(30000)
          httpsConn.setReadTimeout(30000)
          if (officialUserAgent) httpsConn.setRequestProperty('User-Agent', officialUserAgent)
          httpsConn.setRequestProperty('Content-Type', 'application/x-www-form-urlencoded')
          httpsConn.setRequestProperty('Authorization', authorization)
          httpsConn.setRequestProperty('Accept-Encoding', 'identity')
          var outStream = httpsConn.getOutputStream()
          var bodyBytes = Java.use('java.lang.String').$new(finalBody).getBytes('UTF-8')
          outStream.write(bodyBytes)
          outStream.flush()
          outStream.close()

          var responseCode = httpsConn.getResponseCode()
          agentLog('APK HTTP response code=' + responseCode)
          var responseStream
          if (responseCode >= 400) {
            responseStream = httpsConn.getErrorStream()
          } else {
            responseStream = httpsConn.getInputStream()
          }
          var ByteArrayOutputStream = Java.use('java.io.ByteArrayOutputStream')
          var baos = ByteArrayOutputStream.$new()
          var buffer = javaByteArray(new Array(4096).fill(0))
          var bytesRead
          while ((bytesRead = responseStream.read(buffer)) !== -1) {
            baos.write(buffer, 0, bytesRead)
          }
          responseStream.close()
          var responseBody = String(Java.use('java.lang.String').$new(baos.toByteArray(), 'UTF-8'))
          agentLog('APK HTTP response body=' + responseBody.substring(0, Math.min(500, responseBody.length)))

          resolve({
            authorization: authorization,
            body: finalBody,
            authorizationKind: 'native-key-attestation',
            encrypted: encrypted,
            apkResponse: {
              status: responseCode,
              body: responseBody
            }
          })
        } catch (error) {
          reject(error)
        }
      })
    })
  }
  ,

  getRegistrationWireCaptures: function() {
    return registrationWireCaptures
  }
}

function contextPackageName() {
	const ActivityThread = Java.use('android.app.ActivityThread')
	const context = ActivityThread.currentApplication()
	if (!context) throw new Error('Android application context is unavailable')
	return String(context.getPackageName())
}

function installRegistrationWireCapture() {
  // Passive diagnostic: dumps the exact official CJT param map right before
  // the real APK submits a registration request. Used to keep InfiniteAPI's
  // builder 1:1 with the wire; never mutates the request.
  const Client = Java.use('com.whatsapp.registration.core.http.retry.RetryingHttpClient')
  for (const overload of Client.A01.overloads) {
    overload.implementation = function (...args) {
      try {
        const cjt = args[0]
        const entries = cjt.A00.value.entrySet().toArray()
        const params = {}
        for (const entry of entries) {
          params[String(entry.getKey())] = String(entry.getValue())
        }
        recordRegistrationCapture({
          at: new Date().toISOString(),
          source: 'cjt-params',
          endpointKey: String(args[3] ?? ''),
          params: params
        })
        agentLog('captured official registration wire keys=' + Object.keys(params).join(','))
      } catch (captureError) {
        agentLog('registration wire capture failed: ' + captureError)
      }
      return overload.apply(this, args)
    }
  }
}

function installUrlWireCapture() {
  // Low-level diagnostic: catches registration requests regardless of the
  // HTTP stack (KotlinRegistrationBridge or legacy WAMSYS).
  const URL = Java.use('java.net.URL')
  for (const overload of URL.$init.overloads) {
    if (overload.argumentTypes.length < 1) continue
    if (overload.argumentTypes[0].className !== 'java.lang.String' &&
        overload.argumentTypes[0].className !== 'java.net.URL') continue
    overload.implementation = function (first, ...rest) {
      try {
        const spec = String(first)
        if (spec.indexOf('/v2/') !== -1 && spec.indexOf('client_log') === -1) {
          let stackFrames = []
          try {
            const Thread = Java.use('java.lang.Thread')
            const frames = Thread.currentThread().getStackTrace()
            for (let index = 0; index < frames.length && index < 30; index += 1) {
              stackFrames.push(String(frames[index]))
            }
          } catch (stackError) {
            stackFrames = ['stack unavailable: ' + stackError]
          }
          recordRegistrationCapture({
            at: new Date().toISOString(),
            source: 'url',
            url: spec,
            stack: stackFrames
          })
          agentLog('captured official v2 url length=' + spec.length)
          dumpTrackedCjtInstances('url:' + spec.substring(spec.lastIndexOf('/')))
          scheduleCjtHeapScan('url:' + spec.substring(spec.lastIndexOf('/')))
        }
      } catch (captureError) {
        agentLog('url wire capture failed: ' + captureError)
      }
      return overload.call(this, first, ...rest)
    }
  }
}

function looksLikeRegistrationQuery(value) {
  return typeof value === 'string' &&
    (value.indexOf('cc=') !== -1 || value.indexOf('&in=') !== -1 || value.indexOf('token=') !== -1) &&
    value.indexOf('client_log') === -1
}

function installBodyWireCapture() {
  const DataOutputStream = Java.use('java.io.DataOutputStream')
  DataOutputStream.writeBytes.overload('java.lang.String').implementation = function (value) {
    try {
      if (looksLikeRegistrationQuery(String(value))) {
        recordRegistrationCapture({
          at: new Date().toISOString(),
          source: 'body-bytes',
          body: String(value)
        })
        agentLog('captured official registration body via writeBytes length=' + value.length)
      }
    } catch (captureError) {
      agentLog('body wire capture failed: ' + captureError)
    }
    return this.writeBytes(value)
  }

  const URLEncoder = Java.use('java.net.URLEncoder')
  URLEncoder.encode.overload('java.lang.String', 'java.lang.String').implementation = function (value, enc) {
    const result = this.encode(value, enc)
    try {
      const encoded = String(value)
      if (looksLikeRegistrationQuery(encoded) === false && encoded.length > 8) {
        // Fragment-level capture: keep only meaningful registration field values.
        if (encoded.indexOf('@s.whatsapp.net') === -1 && encoded.indexOf(' ') === -1) {
          recordRegistrationCapture({
            at: new Date().toISOString(),
            source: 'urlencode',
            value: encoded
          })
        }
      }
    } catch (captureError) {
      agentLog('urlencode capture failed: ' + captureError)
    }
    return result
  }
}

function captureRegistrationBody(candidate, via) {
  const value = String(candidate)
  if (looksLikeRegistrationQuery(value)) {
    recordRegistrationCapture({
      at: new Date().toISOString(),
      source: via,
      body: value
    })
    agentLog('captured official registration body via ' + via + ' length=' + value.length)
    return true
  }
  return false
}

function installOkioBodyCapture() {
  // The system OkHttp (com.android.okhttp) writes request bodies through
  // okio sinks; hook both the sink wrapper and the buffer it wraps.
  try {
    const RealBufferedSink = Java.use('com.android.okhttp.okio.RealBufferedSink')
    RealBufferedSink.writeUtf8.overload('java.lang.String').implementation = function (value) {
      captureRegistrationBody(value, 'okio-writeUtf8')
      return this.writeUtf8(value)
    }
  } catch (hookError) {
    agentLog('okio RealBufferedSink hook unavailable: ' + hookError)
  }
  try {
    const Buffer = Java.use('com.android.okhttp.okio.Buffer')
    Buffer.writeUtf8.overload('java.lang.String').implementation = function (value) {
      captureRegistrationBody(value, 'buffer-writeUtf8')
      return this.writeUtf8(value)
    }
  } catch (hookError) {
    agentLog('okio Buffer hook unavailable: ' + hookError)
  }
}

function installConnectionSpy() {
  const URLConnection = Java.use('java.net.URLConnection')
  URLConnection.getOutputStream.implementation = function () {
    const out = this.getOutputStream()
    try {
      const url = String(this.getURL().toString())
      if (url.indexOf('/v2/') !== -1 && url.indexOf('client_log') === -1) {
        const streamClass = String(out.getClass().getName())
        let headers = null
        try { headers = String(this.getRequestProperties().toString()) } catch (headerError) { headers = 'unavailable: ' + headerError }
        recordRegistrationCapture({
          at: new Date().toISOString(),
          source: 'conn-info',
          url: url,
          streamClass: streamClass,
          headers: headers
        })
        agentLog('v2 connection streamClass=' + streamClass + ' url=' + url)

        const SpyClass = Java.registerClass({
          name: 'com.lab.SpyOutputStream' + (++spyOutputStreamSequence),
          superClass: Java.use('java.io.OutputStream'),
          fields: { real: 'java.io.OutputStream' },
          methods: {
            write: [
              {
                returnType: 'void',
                argumentTypes: ['int'],
                implementation: function (b) { this.real.value.write(b) }
              },
              {
                returnType: 'void',
                argumentTypes: ['[B'],
                implementation: function (b) {
                  try { captureBodyBytes(b, 0, b.length) } catch (e) { agentLog('spy capture error: ' + e) }
                  this.real.value.write(b)
                }
              },
              {
                returnType: 'void',
                argumentTypes: ['[B', 'int', 'int'],
                implementation: function (b, off, len) {
                  try { captureBodyBytes(b, off, len) } catch (e) { agentLog('spy capture error: ' + e) }
                  this.real.value.write(b, off, len)
                }
              }
            ],
            close: { returnType: 'void', implementation: function () { this.real.value.close() } },
            flush: { returnType: 'void', implementation: function () { this.real.value.flush() } }
          }
        })
        const spy = SpyClass.$new()
        spy.real.value = out
        return Java.cast(spy, Java.use('java.io.OutputStream'))
      }
    } catch (spyError) {
      agentLog('connection spy failed: ' + spyError)
    }
    return out
  }
}

function installNanSpy() {
  // X.Nan.run builds and submits the legacy registration request; dump its
  // instance fields (URL, body bytes, headers) right before it runs.
  try {
    const Nan = Java.use('X.Nan')
    let runOverloads = null
    try { runOverloads = Nan.run.overloads } catch (runProbeError) { runOverloads = null }
    if (!runOverloads) {
      const declared = Nan.class.getDeclaredMethods()
      const names = []
      for (let index = 0; index < declared.length; index += 1) {
        names.push(String(declared[index].getName()) + '/' + String(declared[index].toGenericString()))
      }
      agentLog('X.Nan has no run; declared methods: ' + names.join(' | '))
      return
    }
    const packageName = (() => {
      try {
        const ActivityThread = Java.use('android.app.ActivityThread')
        const context = ActivityThread.currentApplication()
        return context ? String(context.getPackageName()) : 'unknown'
      } catch (e) { return 'unknown' }
    })()
    agentLog('X.Nan armed in package ' + packageName + ' overloads=' + runOverloads.length)
    const spyAndRun = function () {
      try {
        const fields = this.getClass().getDeclaredFields()
        const dump = {}
        for (let index = 0; index < fields.length; index += 1) {
          const field = fields[index]
          field.setAccessible(true)
          const name = String(field.getName())
          try {
            const value = field.get(this)
            if (value === null) { dump[name] = null; continue }
            const typeName = String(value.getClass().getName())
            if (typeName === '[B') {
              const bytes = Java.array('byte', value)
              let preview = ''
              const limit = Math.min(bytes.length, 4096)
              for (let b = 0; b < limit; b += 1) {
                preview += String.fromCharCode(bytes[b] < 0 ? bytes[b] + 256 : bytes[b])
              }
              dump[name] = { type: '[B', size: bytes.length, preview: preview }
            } else {
              dump[name] = String(value).substring(0, 2048)
            }
          } catch (fieldReadError) {
            dump[name] = 'read error: ' + fieldReadError
          }
        }
        recordRegistrationCapture({
          at: new Date().toISOString(),
          source: 'nan-fields',
          package: packageName,
          fields: dump
        })
        agentLog('captured X.Nan instance fields: ' + Object.keys(dump).join(','))
      } catch (nanSpyError) {
        agentLog('X.Nan spy failed: ' + nanSpyError)
      }
      return this.run()
    }
    for (const overload of runOverloads) {
      overload.implementation = spyAndRun
    }
  } catch (nanLoadError) {
    agentLog('X.Nan not loadable: ' + nanLoadError)
  }
}

// ---- Crypto capture: hook javax.crypto.Cipher, Mac, MessageDigest ----
// R8 não pode inlining métodos de framework Android. O plaintext tem que
// passar por Cipher.doFinal() antes de virar ENC=...&H=...

function looksLikeRegistrationPayload(text) {
  if (typeof text !== 'string' || text.length < 5) return false
  return text.indexOf('cc=') !== -1 || text.indexOf('token=') !== -1 ||
         text.indexOf('method=') !== -1 || text.indexOf('in=') !== -1 ||
         text.indexOf('lg=') !== -1 || text.indexOf('fdid=') !== -1
}

function installCryptoCapture() {
  // Hook Cipher.doFinal - catches AES/GCM/CTR encryption
  try {
    const Cipher = Java.use('javax.crypto.Cipher')
    for (const overload of Cipher.doFinal.overloads) {
      overload.implementation = function (...args) {
        try {
          let plaintext = null
          if (args.length >= 1 && args[0] !== null) {
            if (args[0].length !== undefined) {
              // byte[] input
              const bytes = args[0]
              if (bytes.length > 0 && bytes.length < 65536) {
                try {
                  const StringClass = Java.use('java.lang.String')
                  plaintext = StringClass.$new(bytes, 'UTF-8').toString()
                } catch (e) { /* binary data */ }
              }
            }
          }
          if (plaintext && looksLikeRegistrationPayload(plaintext)) {
            recordRegistrationCapture({
              at: new Date().toISOString(),
              source: 'crypto-cipher-dofinal',
              algorithm: this.getAlgorithm(),
              provider: String(this.getProvider()),
              inputLength: plaintext.length,
              plaintext: plaintext.substring(0, 4096)
            })
            agentLog('CIPHER captured registration plaintext len=' + plaintext.length + ' alg=' + this.getAlgorithm())
          }
        } catch (captureError) {
          agentLog('cipher doFinal capture failed: ' + captureError)
        }
        return overload.apply(this, args)
      }
    }
    agentLog('cipher doFinal capture armed')
  } catch (e) {
    agentLog('cipher capture setup failed: ' + e)
  }

  // Hook Mac.doFinal - catches HMAC-SHA256 for the H= parameter
  try {
    const Mac = Java.use('javax.crypto.Mac')
    for (const overload of Mac.doFinal.overloads) {
      overload.implementation = function (...args) {
        try {
          let input = null
          if (args.length >= 1 && args[0] !== null && args[0].length !== undefined && args[0].length > 0 && args[0].length < 65536) {
            try {
              const StringClass = Java.use('java.lang.String')
              input = StringClass.$new(args[0], 'UTF-8').toString()
            } catch (e) { /* binary */ }
          }
          if (input && looksLikeRegistrationPayload(input)) {
            recordRegistrationCapture({
              at: new Date().toISOString(),
              source: 'crypto-mac-dofinal',
              algorithm: this.getAlgorithm(),
              inputLength: input.length,
              input: input.substring(0, 4096)
            })
            agentLog('MAC captured registration HMAC input len=' + input.length + ' alg=' + this.getAlgorithm())
          }
        } catch (captureError) {
          agentLog('mac doFinal capture failed: ' + captureError)
        }
        return overload.apply(this, args)
      }
    }
    agentLog('mac doFinal capture armed')
  } catch (e) {
    agentLog('mac capture setup failed: ' + e)
  }

  // Hook URLEncoder.encode with broader matching to catch serialization
  try {
    const URLEncoder = Java.use('java.net.URLEncoder')
    URLEncoder.encode.overload('java.lang.String', 'java.lang.String').implementation = function (value, enc) {
      const result = this.encode(value, enc)
      try {
        const s = String(value)
        if (s.length > 20 && s.length < 65536 &&
            (s.indexOf('&') !== -1 || s.indexOf('=') !== -1) &&
            s.indexOf('com.') === -1 && s.indexOf('http') === -1) {
          // This is likely a query parameter value or a serialized field
          // Record only if it contains known registration field names
          const regFields = ['cc', 'in', 'lg', 'lc', 'fdid', 'expid', 'token', 'method', 'context']
          for (const field of regFields) {
            if (s === field) {
              recordRegistrationCapture({
                at: new Date().toISOString(),
                source: 'urlencode-field',
                field: field,
                encoded: String(result).substring(0, 256)
              })
              break
            }
          }
        }
      } catch (captureError) { /* ignore */ }
      return result
    }
    agentLog('urlencoder capture updated with field filter')
  } catch (e) {
    agentLog('urlencoder update failed: ' + e)
  }

  return true
}

// ---- Native mbedtls hooks: intercepta cifra no .so antes de virar ENC=...&H=... ----
// Cipher.doFinal e Mac.doFinal do Java não disparam — a cifra é 100% nativa.

function installNativeCryptoCapture() {
  const targets = ['libwhatsappmerged.so', 'libwhatsapp.so']
  // Offsets from ELF .dynsym analysis of libwhatsappmerged.so (x86_64)
  const OFFSETS = {
    'libwhatsappmerged.so': {
      'mbedtls_cipher_update': 0x468ec0,
      'mbedtls_gcm_crypt_and_tag': 0x471cd0,
      'mbedtls_md_hmac': 0x472ee0,
      'mbedtls_hkdf': 0x471fc0
    }
  }

  let armed = false

  for (const libName of targets) {
    const offsets = OFFSETS[libName]
    if (!offsets) continue
    const module = Process.findModuleByName(libName)
    if (!module) continue
    const base = module.base
    agentLog(`native crypto: ${libName} base=${base} size=${module.size}`)

    function hookAt(name, offset, handler) {
      try {
        const addr = base.add(offset)
        // Verify the bytes match what we expect (function prologue check)
        const firstByte = Memory.readU8(addr)
        agentLog(`native: ${name} at ${addr} (first byte: 0x${firstByte.toString(16)})`)
        Interceptor.attach(addr, handler)
        agentLog(`native: ${name} HOOKED at ${addr}`)
        return true
      } catch (e) {
        agentLog(`native: failed to hook ${name}: ${e}`)
        return false
      }
    }

    // Hook mbedtls_cipher_update (args: ctx, iv, iv_len, input, ilen, output, olen)
    armed = hookAt('mbedtls_cipher_update', offsets['mbedtls_cipher_update'], {
      onEnter: function (args) {
        try {
          const ilen = args[4].toInt32()
          if (ilen > 10 && ilen < 65536) {
            const data = Memory.readByteArray(args[3], Math.min(ilen, 4096))
            const text = String.fromCharCode.apply(null, new Uint8Array(data))
            if (text.indexOf('cc=') !== -1 || text.indexOf('token=') !== -1 || text.indexOf('method=') !== -1 || text.indexOf('&in=') !== -1 || text.indexOf('fdid=') !== -1) {
              recordRegistrationCapture({
                at: new Date().toISOString(),
                source: 'native-cipher-update',
                library: libName,
                length: ilen,
                plaintext: text.substring(0, 4096)
              })
              agentLog(`>>> NATIVE CIPHER captured ${ilen} bytes <<<`)
            }
          }
        } catch (e) { /* silent */ }
      }
    }) || armed

    // Hook mbedtls_gcm_crypt_and_tag (args: ctx,mode,length,iv,iv_len,add,add_len,input,output,tag_len,tag)
    armed = hookAt('mbedtls_gcm_crypt_and_tag', offsets['mbedtls_gcm_crypt_and_tag'], {
      onEnter: function (args) {
        try {
          const length = args[2].toInt32()
          if (length > 10 && length < 65536) {
            const data = Memory.readByteArray(args[7], Math.min(length, 4096))
            const text = String.fromCharCode.apply(null, new Uint8Array(data))
            if (text.indexOf('cc=') !== -1 || text.indexOf('token=') !== -1 || text.indexOf('method=') !== -1) {
              recordRegistrationCapture({
                at: new Date().toISOString(),
                source: 'native-gcm-crypt',
                library: libName,
                length: length,
                plaintext: text.substring(0, 4096)
              })
              agentLog(`>>> NATIVE GCM captured ${length} bytes <<<`)
            }
          }
        } catch (e) { /* silent */ }
      }
    }) || armed

    // Hook mbedtls_md_hmac (args: md_info, key, keylen, input, ilen, output)
    armed = hookAt('mbedtls_md_hmac', offsets['mbedtls_md_hmac'], {
      onEnter: function (args) {
        try {
          const ilen = args[4].toInt32()
          if (ilen > 10 && ilen < 65536) {
            const data = Memory.readByteArray(args[3], Math.min(ilen, 4096))
            const text = String.fromCharCode.apply(null, new Uint8Array(data))
            if (text.indexOf('cc=') !== -1 || text.indexOf('token=') !== -1 || text.indexOf('method=') !== -1) {
              recordRegistrationCapture({
                at: new Date().toISOString(),
                source: 'native-hmac',
                library: libName,
                length: ilen,
                input: text.substring(0, 4096)
              })
              agentLog(`>>> NATIVE HMAC captured ${ilen} bytes <<<`)
            }
          }
        } catch (e) { /* silent */ }
      }
    }) || armed

    // Hook mbedtls_hkdf
    armed = hookAt('mbedtls_hkdf', offsets['mbedtls_hkdf'], {
      onEnter: function (args) {
        try {
          agentLog('>>> NATIVE HKDF called <<<')
          recordRegistrationCapture({
            at: new Date().toISOString(),
            source: 'native-hkdf',
            library: libName
          })
        } catch (e) { /* silent */ }
      }
    }) || armed

    if (armed) break
  }

  if (!armed) {
    agentLog('native crypto: no hooks armed, retrying...')
    let retries = 0
    const timer = setInterval(function () {
      retries += 1
      if (retries > 120) { clearInterval(timer); agentLog('native crypto: retry limit'); return }
      for (const libName of targets) {
        if (Process.findModuleByName(libName)) {
          clearInterval(timer)
          agentLog(`native crypto retry: found ${libName} after ${retries} retries`)
          installNativeCryptoCapture()
          return
        }
      }
    }, 500)
  }

  return armed
}
Java.perform(function() {
  const ActivityThread = Java.use('android.app.ActivityThread')
  const context = ActivityThread.currentApplication()
  if (context) {
    agentLog('Frida agent loaded in ' + context.getPackageName())
  } else {
    agentLog('Frida agent loaded before application context; wire capture still armed')
  }
  try {
    agentLog('registration wire capture scheduled across classloaders')
    installClassLoaderCjtCapture()
    agentLog('new classloader capture armed')
    scheduleCjtCapture()
    agentLog('cjt final map capture scheduled across classloaders')
    installUrlWireCapture()
    agentLog('url wire capture armed')
    installBodyWireCapture()
    agentLog('body wire capture armed')
    installOkioBodyCapture()
    agentLog('okio wire capture armed')
    installConnectionSpy()
    agentLog('connection spy armed')
    scheduleMsysWireCapture()
    agentLog('msys wire capture waiting for MSYS class load')
    installNanSpy()
    agentLog('nan spy armed')
    installCryptoCapture()
    agentLog('crypto capture armed')
    installNativeCryptoCapture()
    agentLog('native crypto capture scheduled')
  } catch (captureSetupError) {
    agentLog('registration wire capture setup failed: ' + captureSetupError)
  }
})
