/*--------------------------------------------------------------------------------------
 *  Minimal stand-ins for the handful of `vs/base/common/*` helpers the lifted
 *  token-optimisation modules used inside the VS Code fork.
 *  Zero VS Code dependency: URI comes from the standalone `vscode-uri` package.
 *--------------------------------------------------------------------------------------*/

import { URI } from 'vscode-uri';

export { URI };

/** Replacement for `vs/base/common/uuid.js#generateUuid`. */
export const generateUuid = (): string => crypto.randomUUID();

/** Replacement for `vs/base/common/platform.js#isWindows`. */
export const isWindows: boolean =
	typeof process !== 'undefined' && process.platform === 'win32';

const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[=?>!]?[\d;:]*["$#'* ]?[a-zA-Z@^`{}|~]/;
const OSC_SEQUENCE = /(?:\x1b\]|\x9d).*?(?:\x1b\\|\x07|\x9c)/;
const ESC_SEQUENCE = /\x1b(?:[ #%\(\)\*\+\-\.\/]?[a-zA-Z0-9\|}~@])/;
const CONTROL_SEQUENCES = new RegExp('(?:' + [
	CSI_SEQUENCE.source,
	OSC_SEQUENCE.source,
	ESC_SEQUENCE.source,
].join('|') + ')', 'g');

/** Replacement for `vs/base/common/strings.js#removeAnsiEscapeCodes`. */
export function removeAnsiEscapeCodes(str: string): string {
	if (str) {
		str = str.replace(CONTROL_SEQUENCES, '');
	}
	return str;
}
