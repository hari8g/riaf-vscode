import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ARBITER_SYSTEM, feedbackVote, formatRouteLine, isMultiIntent, loadIntentFeedback, needsArbiter, parseArbiter, recordIntentFeedback, routeIntent, ROUTING_TABLE } from '../../src/v2/intentRouter.js';
import { parseIntent } from '../../src/v2/intent.js';

const LABELLED: [string, keyof typeof ROUTING_TABLE][] = [
	['Fix the NullPointerException thrown by OrderService.capture when the card is expired', 'bugfix'],
	['the build fails with "Cannot find name TariffSlab" — fix it', 'bugfix'],
	['Add exponential backoff (3 retries, jitter) to the charger status poller', 'feature'],
	['Implement a CSV export for the settlement report', 'feature'],
	['Refactor PaymentClient: extract the retry logic into its own module', 'refactor'],
	['Rename TollTransaction to TollEvent everywhere', 'refactor'],
	['How does a toll transaction get from the ANPR camera to the settlement table?', 'explain'],
	['Where is the retry logic for payment capture?', 'explain'],
	['Write unit tests for the plate-number checksum', 'test'],
	['Add missing test cases for parseIntent', 'test'],
	['Migrate the service from Spring Boot 2 to Spring Boot 3', 'migrate'],
	['Upgrade vitest from 2 to 3 and fix the deprecations', 'migrate'],
	['Review this merge request for security issues', 'review'],
	['Audit the Terraform under infra/ for public buckets', 'review'],
];

describe('intentRouter: routing table', () => {
	it.each(LABELLED)('routes "%s" → %s', async (req, type) => {
		const r = await routeIntent(req);
		expect(r.type).toBe(type);
		expect(r.mode).toBe(ROUTING_TABLE[type].mode);
		expect(r.budget).toBe(ROUTING_TABLE[type].budget);
		expect(r.askFirst).toBe(false);
	});

	it('explain and review are read-only; plan-gated types start read-only-then-full', async () => {
		expect((await routeIntent('explain the settlement flow')).tools).toBe('read-only');
		expect((await routeIntent('add a dark mode toggle to the settings page')).tools).toBe('read-only-then-full');
		expect((await routeIntent('add a dark mode toggle to the settings page')).planGate).toBe(true);
	});

	it('an explicit command beats the classifier and never plan-gates', async () => {
		const r = await routeIntent('add a dark mode toggle', { command: 'explain' });
		expect(r.source).toBe('command');
		expect(r.mode).toBe('explain');
		expect(r.type).toBe('explain');
		expect(r.planGate).toBe(false);
		const p = await routeIntent('fix the crash in parseIntent', { command: 'plan' });
		expect(p.mode).toBe('plan');
		expect(p.type).toBe('bugfix'); // /plan keeps a confident classification
	});

	it('asks instead of starting when the request is too thin', async () => {
		const r = await routeIntent('fix it');
		expect(r.askFirst).toBe(true);
		expect(r.questions.length).toBeGreaterThan(0);
	});

	it('settings can override a rule', async () => {
		const r = await routeIntent('add a CSV export', { rules: { feature: { planGate: false, budget: 4_000 } } });
		expect(r.planGate).toBe(false);
		expect(r.budget).toBe(4_000);
	});
});

describe('intentRouter: arbiter', () => {
	it('detects multi-intent requests', () => {
		expect(isMultiIntent('fix the NPE in OrderService and then write a unit test for it').multi).toBe(true);
		expect(isMultiIntent('explain how the poller works').multi).toBe(false);
	});

	it('needsArbiter fires on low confidence, close scores or multi-intent', () => {
		const vague = parseIntent('update the thing');
		expect(needsArbiter(vague, 'update the thing')).toBe(true);
		const clear = parseIntent('How does the ANPR pipeline reach the settlement table?');
		expect(needsArbiter(clear, 'How does the ANPR pipeline reach the settlement table?')).toBe(false);
	});

	it('parses and validates arbiter output, ignoring junk', () => {
		expect(parseArbiter('Sure! {"type":"Bugfix","confidence":0.9,"scope_paths":["src/payments/","../etc"],"secondary_type":"test"}')).toEqual({ type: 'bugfix', secondary_type: 'test', confidence: 0.9, scope_paths: ['src/payments/'], clarify: undefined });
		expect(parseArbiter('{"type":"deploy"}')).toBeNull();
		expect(parseArbiter('no json here')).toBeNull();
	});

	it('uses the arbiter only when unsure, blends confidence and takes its scope', async () => {
		let calls = 0;
		const classify = async (system: string, user: string) => { calls++; expect(system).toBe(ARBITER_SYSTEM); expect(user).toContain('Request:'); return '{"type":"migrate","confidence":0.8,"scope_paths":["services/billing/"]}'; };
		const sure = await routeIntent('How does the ANPR pipeline reach the settlement table?', { classify });
		expect(calls).toBe(0);
		expect(sure.source).toBe('lexicon');
		const unsure = await routeIntent('move billing to the new provider', { classify });
		expect(calls).toBe(1);
		expect(unsure.source).toBe('arbiter');
		expect(unsure.type).toBe('migrate');
		expect(unsure.scope).toBe('services/billing/');
		expect(unsure.arbiter?.used).toBe(true);
	});

	it('falls back to tier 1 when the arbiter fails or times out', async () => {
		const bad = await routeIntent('move billing to the new provider', { classify: async () => 'nope' });
		expect(bad.source).toBe('lexicon');
		expect(bad.arbiter?.error).toBe('unparseable reply');
		const slow = await routeIntent('move billing to the new provider', { classify: () => new Promise(res => setTimeout(() => res('{"type":"bugfix"}'), 50)), timeoutMs: 5 });
		expect(slow.source).toBe('lexicon');
		expect(slow.arbiter?.error).toMatch(/timed out/);
	});

	it('an arbiter clarify question can turn a route into askFirst', async () => {
		const r = await routeIntent('do the thing', { classify: async () => '{"type":"feature","confidence":0.2,"clarify":"Which thing, in which module?"}' });
		expect(r.askFirst).toBe(true);
		expect(r.questions[0]).toBe('Which thing, in which module?');
	});
});

describe('intentRouter: feedback lexicon', () => {
	const root = mkdtempSync(join(tmpdir(), 'riaf-fb-'));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it('records, reloads and votes', async () => {
		expect(loadIntentFeedback(root)).toEqual([]);
		recordIntentFeedback(root, { request: 'tidy up the settlement exporter', predicted: 'feature', corrected: 'refactor' });
		const fb = loadIntentFeedback(root);
		expect(fb).toHaveLength(1);
		expect(feedbackVote(fb, 'tidy up the settlement exporter')).toEqual({ type: 'refactor', strength: 1 });
		expect(feedbackVote(fb, 'please tidy the settlement exporter module')?.type).toBe('refactor');
		expect(feedbackVote(fb, 'unrelated request')).toBeNull();
		const r = await routeIntent('tidy up the settlement exporter', { root });
		expect(r.source).toBe('feedback');
		expect(r.type).toBe('refactor');
	});
});

describe('formatRouteLine', () => {
	it('is one line with the essentials', async () => {
		const r = await routeIntent('Fix the NullPointerException thrown by OrderService.capture');
		const line = formatRouteLine(r, { items: 14, tokens: 11_200 });
		expect(line).toMatch(/^Intent: bugfix \(0\.\d+, lexicon\)/);
		expect(line).toContain('OrderService');
		expect(line).toContain('pack: 14 items / 11.2k tokens');
		expect(line.split('\n')).toHaveLength(1);
	});
});

describe('parseIntent: acceptance and constraint hygiene', () => {
	it('drops code fragments, one-word items and repeats', () => {
		const i = parseIntent('Add dedupe to ledger.py. It should ignore repeated rows within 5 minutes. it should ignore repeated rows within 5 minutes. Then expect(screen.getByText("x")); and keep it fast; do not touch billing.py');
		expect(i.acceptance.filter(a => /ignore repeated rows/i.test(a))).toHaveLength(1);
		expect(i.acceptance.some(a => /expect\(|=>|;/.test(a))).toBe(false);
		expect(i.constraints.some(c => /[;{}]|=>/.test(c))).toBe(false);
		expect(i.constraints.join(' ')).toMatch(/do not touch billing/);
	});
});
