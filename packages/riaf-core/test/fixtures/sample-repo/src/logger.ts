export interface Logger {
	info(message: string): void;
	warn(message: string): void;
}

export function createLogger(scope: string): Logger {
	const prefix = `[${scope}]`;
	return {
		info: (message) => console.log(prefix, message),
		warn: (message) => console.warn(prefix, message),
	};
}
