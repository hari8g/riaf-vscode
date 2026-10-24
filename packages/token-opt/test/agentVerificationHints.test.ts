/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import type { WorkspaceProfile } from '../src/types.js';
import {
	buildSandboxVerificationHint,
	createSandboxVerificationTracker,
	isLocalhostCurlCommand,
	isSandboxVerificationCommand,
	markSandboxCodeChange,
	markSandboxVerified,
	needsSandboxVerification,
} from '../src/agentVerificationHints.js';

describe('Trove - agentVerificationHints', () => {

	it('needsSandboxVerification when edits exist but no terminal verification', () => {
		const tracker = createSandboxVerificationTracker();
		const fileEditCounts = new Map<string, number>();
		const webProfile = {
			testCommands: [{ command: 'npm test', purpose: 'test', confidence: 'high' }],
			buildCommands: [{ command: 'npm start', purpose: 'start', confidence: 'high' }],
		} as unknown as WorkspaceProfile;
		assert.strictEqual(needsSandboxVerification(tracker, fileEditCounts, webProfile), false);

		markSandboxCodeChange(tracker);
		assert.strictEqual(needsSandboxVerification(tracker, fileEditCounts, webProfile), true);
		assert.strictEqual(needsSandboxVerification(tracker, fileEditCounts, null), false);

		markSandboxVerified(tracker, 'curl http://localhost:3000', 'ok', { type: 'done', exitCode: 0 });
		assert.strictEqual(needsSandboxVerification(tracker, fileEditCounts, webProfile), false);
	});

	it('isSandboxVerificationCommand recognizes build, test, dev server, and curl', () => {
		assert.strictEqual(isSandboxVerificationCommand('npm test'), true);
		assert.strictEqual(isSandboxVerificationCommand('npm run build'), true);
		assert.strictEqual(isSandboxVerificationCommand('npm run start'), true);
		assert.strictEqual(isLocalhostCurlCommand('curl http://localhost:3000'), true);
		assert.strictEqual(isSandboxVerificationCommand('npm install'), false);
	});

	it('buildSandboxVerificationHint includes mandatory verification language', () => {
		const hint = buildSandboxVerificationHint(null);
		assert.ok(hint.includes('SANDBOX VERIFICATION REQUIRED'));
		assert.ok(hint.includes('run_command'));
	});
});
