/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import { URI } from '../src/shim/vsBase.js';
import { completeRemainingPlanItems, generateAgentPlan, isContinuationUserMessage, isLikelyNewTaskUserMessage, markPlanItemDoneForTool, parsePlanBulletItems, planHasPendingItems, reactivateAbortedPlan, resolveAgentPlanForRun } from '../src/agentPlan.js';
import type { ChatMessage } from '../src/types.js';
import type { UsageMeterPort } from '../src/ports.js';

describe('Trove - agentPlan', () => {

	it('parsePlanBulletItems parses dash and numbered lists', () => {
		const text = [
			'- Read Sidebar.tsx',
			'* Create Spinner component',
			'1. Wire into Sidebar.tsx',
		].join('\n');
		const items = parsePlanBulletItems(text);
		assert.strictEqual(items.length, 3);
		assert.strictEqual(items[0].text, 'Read Sidebar.tsx');
		assert.strictEqual(items[0].status, 'pending');
	});

	it('markPlanItemDoneForTool marks locate then read steps', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Locate the index.html file', status: 'pending' as const },
				{ text: 'Open index.html to inspect its current structure', status: 'pending' as const },
				{ text: 'Add a small comment at the top of index.html', status: 'pending' as const },
			],
		};
		const uri = URI.file('/workspace/index.html');

		const afterSearch = markPlanItemDoneForTool(plan, 'search_for_files', { query: 'index.html', pageNumber: 1 } as any);
		assert.strictEqual(afterSearch.items[0].status, 'done');
		assert.strictEqual(afterSearch.items[1].status, 'pending');

		const afterRead = markPlanItemDoneForTool(afterSearch, 'read_file', { uri, startLine: 1, endLine: 50, pageNumber: 1 });
		assert.strictEqual(afterRead.items[1].status, 'done');
		assert.strictEqual(afterRead.items[2].status, 'pending');
	});

	it('markPlanItemDoneForTool marks add and save steps on edit', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Open index.html to inspect its current structure', status: 'done' as const },
				{ text: 'Add a small comment at the top of index.html', status: 'pending' as const },
				{ text: 'Save the updated index.html', status: 'pending' as const },
				{ text: 'Verify the comment appears correctly at the top', status: 'pending' as const },
			],
		};
		const uri = URI.file('/workspace/index.html');

		const afterEdit = markPlanItemDoneForTool(plan, 'edit_file', { uri, search_replace_blocks: '...' } as any);
		assert.strictEqual(afterEdit.items[1].status, 'done');
		assert.strictEqual(afterEdit.items[2].status, 'done');
		assert.strictEqual(afterEdit.items[3].status, 'pending');
	});

	it('completeRemainingPlanItems marks all pending steps done', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Read file', status: 'done' as const },
				{ text: 'Verify output', status: 'pending' as const },
			],
		};
		const completed = completeRemainingPlanItems(plan);
		assert.strictEqual(completed.items[0].status, 'done');
		assert.strictEqual(completed.items[1].status, 'done');
	});

	it('parsePlanBulletItems caps at eight items', () => {
		const lines = Array.from({ length: 10 }, (_, i) => `- Step ${i + 1}`);
		const items = parsePlanBulletItems(lines.join('\n'));
		assert.strictEqual(items.length, 8);
	});

	it('markPlanItemDoneForTool marks create and skips redundant read step', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Read NewComponent.tsx', status: 'pending' as const },
				{ text: 'Create NewComponent.tsx', status: 'pending' as const },
				{ text: 'Run tests', status: 'pending' as const },
			],
		};
		const uri = URI.file('/workspace/NewComponent.tsx');

		const afterCreate = markPlanItemDoneForTool(plan, 'create_file_or_folder', { uri, isFolder: false });
		assert.strictEqual(afterCreate.items[0].status, 'skipped');
		assert.strictEqual(afterCreate.items[1].status, 'done');
		assert.strictEqual(afterCreate.items[2].status, 'pending');
	});

	it('generateAgentPlan rejects plans with fewer than three bullets', async () => {
		const chatMessages: ChatMessage[] = [{
			role: 'user',
			displayContent: 'fix the tests',
			content: 'fix the tests',
			selections: null,
			state: { stagingSelections: [], isBeingEdited: false },
		}];

		const plan = await generateAgentPlan({
			callLLM: async () => ({
				text: '- Read package.json\n- Run tests',
				usage: { inputTokens: 250, outputTokens: 40, cacheReadTokens: 0 },
			}),
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			chatMode: 'agent',
			chatMessages,
			threadId: 'thread-plan-1',
		});

		assert.strictEqual(plan, null);
	});

	it('generateAgentPlan records usage via metering service', async () => {
		const recorded: Array<{ threadId: string; inputTokens: number }> = [];
		const usageMeter: UsageMeterPort = {
			record: (usage, meta) => {
				recorded.push({ threadId: meta.threadId ?? '', inputTokens: usage.inputTokens });
			},
		};

		const chatMessages: ChatMessage[] = [{
			role: 'user',
			displayContent: 'fix the tests',
			content: 'fix the tests',
			selections: null,
			state: { stagingSelections: [], isBeingEdited: false },
		}];

		const plan = await generateAgentPlan({
			callLLM: async () => ({
				text: '- Read package.json\n- Update tests\n- Run tests',
				usage: { inputTokens: 250, outputTokens: 40, cacheReadTokens: 0 },
			}),
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			chatMode: 'agent',
			chatMessages,
			threadId: 'thread-plan-1',
			usageMeter,
		});

		assert.ok(plan);
		assert.strictEqual(plan!.items.length, 3);
		assert.strictEqual(recorded.length, 1);
		assert.strictEqual(recorded[0].threadId, 'thread-plan-1');
		assert.strictEqual(recorded[0].inputTokens, 250);
	});

	it('isContinuationUserMessage detects short continue prompts', () => {
		assert.strictEqual(isContinuationUserMessage('continue'), true);
		assert.strictEqual(isContinuationUserMessage('Please continue.'), true);
		assert.strictEqual(isContinuationUserMessage('Implement a new auth module with JWT'), false);
	});

	it('reactivateAbortedPlan restores skipped steps to pending', () => {
		const plan = {
			role: 'plan' as const,
			items: [
				{ text: 'Read file', status: 'done' as const },
				{ text: 'Edit file', status: 'skipped' as const },
				{ text: 'Run tests', status: 'skipped' as const },
			],
		};
		const reactivated = reactivateAbortedPlan(plan);
		assert.ok(reactivated);
		assert.strictEqual(reactivated!.items[0].status, 'done');
		assert.strictEqual(reactivated!.items[1].status, 'pending');
		assert.strictEqual(reactivated!.items[2].status, 'pending');
	});

	it('resolveAgentPlanForRun reuses plan with pending items', async () => {
		const chatMessages: ChatMessage[] = [
			{ role: 'user', displayContent: 'build feature', content: 'build feature', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
			{ role: 'plan', items: [
				{ text: 'Read A', status: 'done' },
				{ text: 'Edit A', status: 'pending' },
				{ text: 'Run tests', status: 'pending' },
			] },
			{ role: 'user', displayContent: 'continue', content: 'continue', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
		];

		const resolution = await resolveAgentPlanForRun({
			callLLM: async () => { throw new Error('should not call LLM'); },
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			chatMode: 'agent',
			chatMessages,
			threadId: 'thread-resume-1',
		});

		assert.strictEqual(resolution.action, 'reuse');
	});

	it('resolveAgentPlanForRun reactivates skipped plan on continue', async () => {
		const chatMessages: ChatMessage[] = [
			{ role: 'user', displayContent: 'build feature', content: 'build feature', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
			{ role: 'plan', items: [
				{ text: 'Read A', status: 'done' },
				{ text: 'Edit A', status: 'skipped' },
				{ text: 'Run tests', status: 'skipped' },
			] },
			{ role: 'user', displayContent: 'continue', content: 'continue', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
		];

		const resolution = await resolveAgentPlanForRun({
			callLLM: async () => { throw new Error('should not call LLM'); },
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			chatMode: 'agent',
			chatMessages,
			threadId: 'thread-resume-2',
		});

		assert.strictEqual(resolution.action, 'reactivate');
		if (resolution.action === 'reactivate') {
			assert.strictEqual(resolution.plan.items[1].status, 'pending');
		}
	});

	it('resolveAgentPlanForRun returns none when generation fails without blocking', async () => {
		const chatMessages: ChatMessage[] = [{
			role: 'user',
			displayContent: 'brand new task with enough detail to avoid continuation heuristics triggering incorrectly here',
			content: 'brand new task with enough detail to avoid continuation heuristics triggering incorrectly here',
			selections: null,
			state: { stagingSelections: [], isBeingEdited: false },
		}];

		const resolution = await resolveAgentPlanForRun({
			callLLM: async () => { throw new Error('plan failed'); },
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			chatMode: 'agent',
			chatMessages,
			threadId: 'thread-resume-3',
		});

		assert.strictEqual(resolution.action, 'none');
	});

	it('planHasPendingItems detects pending checklist rows', () => {
		assert.strictEqual(planHasPendingItems({
			role: 'plan',
			items: [{ text: 'A', status: 'done' }, { text: 'B', status: 'pending' }],
		}), true);
		assert.strictEqual(isLikelyNewTaskUserMessage('Instead, implement OAuth login from scratch with a new provider module'), true);
	});
});
