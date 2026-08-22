declare global {
	interface RequestInit {
		agent?: import('http').Agent
		dispatcher?: any
		duplex?: 'half' | 'full'
	}
}

export {}
