declare global {
	interface RequestInit {
		agent?: import('http').Agent
		dispatcher?: unknown
		duplex?: 'half' | 'full'
	}
}

export {}
