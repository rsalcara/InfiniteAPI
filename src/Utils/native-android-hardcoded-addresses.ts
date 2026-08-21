/**
 * Last-resort addresses captured from the Android 2.26.27.83 connection table
 * (the `NAH` initializer in the decompiled APK). DNS and server-provided
 * candidates always run first. These addresses are intentionally a fallback,
 * not a replacement for values delivered by WhatsApp. Embedders can replace
 * individual host entries through nativeAndroid.hardcodedAddresses.
 */
const EDGE_ADDRESSES = ['15.197.206.217', '3.33.252.61', '15.197.210.208', '3.33.221.48']

export const OFFICIAL_NATIVE_ANDROID_HARDCODED_ADDRESSES: Readonly<Record<string, readonly string[]>> = {
	'g.whatsapp.net': [
		'57.144.253.33',
		'57.144.79.33',
		'57.144.133.33',
		'57.144.219.33',
		'31.13.93.54',
		'57.144.195.33',
		'57.144.201.33',
		'57.145.21.33',
		'31.13.66.51',
		'57.144.75.33',
		'57.145.3.33',
		'31.13.70.50',
		'157.240.11.54',
		'57.144.203.33',
		'31.13.71.50',
		'157.240.241.61',
		'57.144.181.33',
		'57.144.23.33',
		'157.240.14.53',
		'57.144.163.33',
		'57.144.197.33',
		'57.144.199.33',
		'157.240.3.55',
		'57.144.217.33',
		'157.240.22.54',
		'57.144.221.33',
		'2a03:2880:f37e:121:face:b00c:0:7260',
		'2a03:2880:f31e:121:face:b00c:0:7260',
		'2a03:2880:f342:121:face:b00c:0:7260',
		'2a03:2880:f36d:121:face:b00c:0:7260',
		'2a03:2880:f234:1c7:face:b00c:0:7260',
		'2a03:2880:f361:121:face:b00c:0:7260',
		'2a03:2880:f364:121:face:b00c:0:7260',
		'2a03:2880:f38a:121:face:b00c:0:7260',
		'2a03:2880:f203:c6:face:b00c:0:7260',
		'2a03:2880:f31d:121:face:b00c:0:7260',
		'2a03:2880:f381:121:face:b00c:0:7260',
		'2a03:2880:f20d:c6:face:b00c:0:7260',
		'2a03:2880:f20d:1c6:face:b00c:0:7260',
		'2a03:2880:f365:121:face:b00c:0:7260',
		'2a03:2880:f212:c6:face:b00c:0:7260',
		'2a03:2880:f212:1c4:face:b00c:0:7260',
		'2a03:2880:f35a:121:face:b00c:0:7260',
		'2a03:2880:f332:121:face:b00c:0:7260',
		'2a03:2880:f22c:1c6:face:b00c:0:7260',
		'2a03:2880:f351:121:face:b00c:0:7260',
		'2a03:2880:f362:121:face:b00c:0:7260',
		'2a03:2880:f363:121:face:b00c:0:7260',
		'2a03:2880:f201:c6:face:b00c:0:7260',
		'2a03:2880:f36c:121:face:b00c:0:7260',
		'2a03:2880:f231:c7:face:b00c:0:7260',
		'2a03:2880:f36e:121:face:b00c:0:7260'
	],
	...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`e${index + 1}.whatsapp.net`, EDGE_ADDRESSES]))
}

export const resolveNativeAndroidHardcodedAddresses = (overrides?: Record<string, string[]>) => ({
	...OFFICIAL_NATIVE_ANDROID_HARDCODED_ADDRESSES,
	...overrides
})
