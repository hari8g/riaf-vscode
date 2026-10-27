import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInteractionList, rememberInteraction } from '@bosch-mps/riaf-engine';

const fileOf = (root: string) => join(root, '.riaf', 'interactions.json');

export function recentInteractions(root: string): string[] {
	try { return readInteractionList(readFileSync(fileOf(root), 'utf8')); } catch { return []; }
}

export function noteInteraction(root: string, file: string): void {
	try {
		mkdirSync(join(root, '.riaf'), { recursive: true });
		writeFileSync(fileOf(root), JSON.stringify(rememberInteraction(recentInteractions(root), file)));
	} catch { /* the search boost is optional */ }
}

export function readCoChange(root: string): Record<string, Record<string, number>> | undefined {
	try { return JSON.parse(readFileSync(join(root, '.riaf', 'cochange.json'), 'utf8')) as Record<string, Record<string, number>>; }
	catch { return undefined; }
}
