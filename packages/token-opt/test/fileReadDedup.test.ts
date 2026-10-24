/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import { URI } from '../src/shim/vsBase.js';
import {
	buildRepeatFileReadHint,
	formatReadFileRange,
	readFileUriKey,
	shouldSkipDuplicateFileRead,
	trackFileRead,
} from '../src/fileReadDedup.js';
import { createReadOnlyCallCounts, trackReadOnlyCall } from '../src/agentReadHints.js';
import {
	getEffectiveMaxReadOnlyCalls,
	getEffectiveRepoProfileMode,
	isLightAgentEnabled,
	shouldGenerateAgentPlan,
	shouldUseParallelReadBatching,
} from '../src/lightAgent.js';
import { defaultGlobalSettings } from '../src/types.js';

describe('Trove - fileReadDedup', () => {

	it('shouldSkipDuplicateFileRead skips only when range is fully covered', () => {
		const fileReads = new Map<string, { count: number; ranges: string[] }>();
		const uri = URI.file('/proj/clock.js');
		trackFileRead(fileReads, uri, 1, 120);
		const uncovered = shouldSkipDuplicateFileRead(fileReads, uri, 270, 380);
		assert.strictEqual(uncovered.skip, false);

		const covered = shouldSkipDuplicateFileRead(fileReads, uri, 50, 100);
		assert.strictEqual(covered.skip, true);
		assert.ok(covered.message?.includes('already read'));
		assert.ok(covered.message?.includes('lines 1-120'));
	});

	it('trackReadOnlyCall tracks file-level reads across ranges', () => {
		const counts = createReadOnlyCallCounts();
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/clock.js', startLine: '1', endLine: '120' });
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/clock.js', startLine: '270', endLine: '380' });
		assert.strictEqual(counts.fileReads.get(readFileUriKey('/proj/clock.js'))?.count, 2);
		assert.deepStrictEqual(counts.fileReads.get(readFileUriKey('/proj/clock.js'))?.ranges, [
			formatReadFileRange(1, 120),
			formatReadFileRange(270, 380),
		]);
		const hint = buildRepeatFileReadHint(counts.fileReads);
		assert.ok(hint.includes('clock.js'));
	});

	it('trackFileRead stamps lastReadTurn when turn is provided', () => {
		const fileReads = new Map<string, { count: number; ranges: string[]; lastReadTurn?: number }>();
		const uri = URI.file('/proj/foo.ts');
		trackFileRead(fileReads, uri, null, null, undefined, 3);
		assert.strictEqual(fileReads.get(readFileUriKey(uri))?.lastReadTurn, 3);
	});

	it('trackReadOnlyCall passes userTurn to file read records', () => {
		const counts = createReadOnlyCallCounts();
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/foo.ts' }, 5);
		assert.strictEqual(counts.fileReads.get(readFileUriKey('/proj/foo.ts'))?.lastReadTurn, 5);
	});

	it('eviction window keeps only last 2 user turns', () => {
		const fileReads = new Map<string, { count: number; ranges: string[]; lastReadTurn?: number }>();
		const uri1 = URI.file('/proj/old.ts');
		const uri2 = URI.file('/proj/recent.ts');
		trackFileRead(fileReads, uri1, null, null, undefined, 1);
		trackFileRead(fileReads, uri2, null, null, undefined, 3);
		const currentTurn = 4;
		const kept = new Map<string, { count: number; ranges: string[]; lastReadTurn?: number }>();
		for (const [key, record] of fileReads) {
			const lastTurn = record.lastReadTurn ?? currentTurn;
			if (currentTurn - lastTurn > 2) continue;
			kept.set(key, record);
		}
		assert.strictEqual(kept.has(readFileUriKey(uri1)), false);
		assert.strictEqual(kept.has(readFileUriKey(uri2)), true);
	});
});

describe('Trove - lightAgent', () => {

	it('light agent disables plan and parallel batching', () => {
		const settings = { ...defaultGlobalSettings, enableLightAgent: true, enableAgentPlan: true, enableParallelReadBatching: true };
		assert.strictEqual(isLightAgentEnabled(settings), true);
		assert.strictEqual(shouldGenerateAgentPlan(settings), false);
		assert.strictEqual(shouldUseParallelReadBatching(settings), false);
	});

	it('light agent caps read-only calls and shrinks repo profile mode', () => {
		const settings = { ...defaultGlobalSettings, enableLightAgent: true, maxReadOnlyCalls: 12 };
		assert.strictEqual(getEffectiveMaxReadOnlyCalls(settings), 6);
		assert.strictEqual(getEffectiveRepoProfileMode('agent', settings), 'normal');
	});
});
