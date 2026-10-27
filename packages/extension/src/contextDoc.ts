import { renderContextDocument, testSourceMap } from '@bosch-mps/riaf-engine';
import { readSettings } from './config.js';
import { createTransport, type ModelTransport } from './modelTransport.js';

/** Index report plus an optional model summary and the test/source pairs that exist in `files`. */
export async function buildContextMarkdown(opts: { name: string; report: string; files?: string[]; transport?: ModelTransport }): Promise<string> {
	const transport = opts.transport ?? await createTransport(undefined, readSettings().models.summary || undefined);
	let summary = '';
	if (transport) {
		try {
			const result = await transport.call({ systemMessage: 'Summarise this repository in 6-10 lines of plain text.', messages: [{ role: 'user', text: opts.report.slice(0, 6_000) }], maxOutputTokens: 400 });
			summary = result.text.trim();
		} catch { summary = ''; }
	}
	const pairs = testSourceMap(opts.files ?? []).filter(pair => pair.present);
	return renderContextDocument({ name: opts.name, report: opts.report, summary, pairs });
}
