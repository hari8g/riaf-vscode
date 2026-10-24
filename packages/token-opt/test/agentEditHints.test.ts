/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import { URI } from '../src/shim/vsBase.js';
import { buildLargeFileEditHint, buildRepeatEditHint, trackFileEdit } from '../src/agentEditHints.js';

describe('Trove - agentEditHints', () => {

	it('buildRepeatEditHint is empty until threshold', () => {
		const counts = new Map<string, number>();
		assert.strictEqual(buildRepeatEditHint(counts), '');
		trackFileEdit(counts, 'edit_file', { uri: URI.file('/proj/style.css') });
		assert.strictEqual(buildRepeatEditHint(counts), '');
		trackFileEdit(counts, 'edit_file', { uri: URI.file('/proj/style.css') });
		const hint = buildRepeatEditHint(counts);
		assert.ok(hint.includes('style.css'));
		assert.ok(hint.includes('edit_file'));
	});

	it('buildLargeFileEditHint warns on large reads', () => {
		const fileReads = new Map([['/proj/style.css', { count: 1, ranges: ['full file'], totalFileLen: 8000 }]]);
		const hint = buildLargeFileEditHint(fileReads);
		assert.ok(hint.includes('style.css'));
		assert.ok(hint.includes('rewrite_file'));
		assert.strictEqual(buildLargeFileEditHint(new Map()), '');
	});
});
