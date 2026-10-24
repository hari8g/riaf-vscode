/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	buildEditCompletionHint,
	createEditCompletionTracker,
	detectEditIntentFromText,
	isMissingEditContentError,
	markInterruptedEditTool,
	needsEditCompletion,
} from '../src/agentEditCompletionHints.js';

describe('Trove - agentEditCompletionHints', () => {

	it('detectEditIntentFromText recognizes edit and styling requests', () => {
		assert.strictEqual(detectEditIntentFromText('edit the file style.css to introduce argentina team styling'), true);
		assert.strictEqual(detectEditIntentFromText('what is this project?'), false);
	});

	it('needsEditCompletion when exploration happened but no edits', () => {
		const tracker = createEditCompletionTracker();
		const fileEditCounts = new Map<string, number>();
		assert.strictEqual(needsEditCompletion({
			tracker,
			fileEditCounts,
			readOnlyCallCount: 3,
			userMessage: 'edit style.css for argentina theme',
			chatMode: 'agent',
		}), true);

		fileEditCounts.set('/tmp/style.css', 1);
		assert.strictEqual(needsEditCompletion({
			tracker,
			fileEditCounts,
			readOnlyCallCount: 3,
			userMessage: 'edit style.css for argentina theme',
			chatMode: 'agent',
		}), false);
	});

	it('needsEditCompletion when edit tool stream was interrupted', () => {
		const tracker = createEditCompletionTracker();
		markInterruptedEditTool(tracker);
		assert.strictEqual(needsEditCompletion({
			tracker,
			fileEditCounts: new Map(),
			readOnlyCallCount: 0,
			userMessage: 'edit style.css',
			chatMode: 'agent',
		}), true);
	});

	it('isMissingEditContentError detects truncated edit_file params', () => {
		assert.strictEqual(
			isMissingEditContentError('edit_file', 'Invalid LLM output format: searchReplaceBlocks must be a string'),
			true,
		);
	});

	it('buildEditCompletionHint includes mandatory edit language', () => {
		const hint = buildEditCompletionHint({ interruptedEditTool: true });
		assert.ok(hint.includes('MANDATORY'));
		assert.ok(hint.includes('edit_file'));
	});

	it('buildEditCompletionHint explains truncation recovery', () => {
		const hint = buildEditCompletionHint({ interruptedEditTool: false, truncatedEditTool: true });
		assert.ok(hint.includes('TRUNCATED'));
		assert.ok(hint.includes('edit_file'));
		assert.ok(!hint.includes('rewrite_file with the complete'));
	});
});
