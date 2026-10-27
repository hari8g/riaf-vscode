import { describe, expect, it } from 'vitest';
import { createEmbedder } from '../src/embeddingService.js';

describe('createEmbedder', () => {
	it('uses the injected fetch so a proxy agent can be supplied by the host', async () => {
		const calls: string[] = [];
		const embedder = createEmbedder({
			enabled: true,
			url: 'https://gateway.example/v1/embeddings',
			model: 'embed',
			fetchImpl: async (url, init) => {
				calls.push(`${init?.method} ${url}`);
				const body = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({
					data: (body.input as string[]).map((_: string, index: number) => ({ index, embedding: [index, 1] })),
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			},
		});
		const vec = await embedder!.embedText('hello');
		expect(calls).toEqual(['POST https://gateway.example/v1/embeddings']);
		expect(vec).toEqual([0, 1]);
	});
});
