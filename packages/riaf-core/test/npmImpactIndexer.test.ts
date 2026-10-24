import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { indexNpmDependencies } from '../src/npmImpactIndexer.js';

describe('Trove - npmImpactIndexer', () => {

	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trove-npm-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	it('indexes scoped dependencies from package.json', () => {
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
			dependencies: {
				'@mobilitystore/shared-lib': '1.2.3',
				'lodash': '4.17.21',
			},
			devDependencies: {
				'@bosch/toolkit': '0.1.0',
			},
		}, null, 2));

		const result = indexNpmDependencies(tempDir);
		assert.strictEqual(result.packageJsonCount, 1);
		assert.strictEqual(result.edges.length, 2);
		assert.ok(result.edges.some(e => e.packageName === '@mobilitystore/shared-lib' && e.depType === 'dependencies'));
		assert.ok(result.edges.some(e => e.packageName === '@bosch/toolkit' && e.depType === 'devDependencies'));
		assert.ok(result.edges.every(e => !e.packageName.startsWith('lodash')));
	});

	it('respects custom scope filter', () => {
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
			dependencies: {
				'@custom/only-this': '1.0.0',
				'@mobilitystore/other': '2.0.0',
			},
		}, null, 2));

		const result = indexNpmDependencies(tempDir, ['@custom']);
		assert.strictEqual(result.edges.length, 1);
		assert.strictEqual(result.edges[0].packageName, '@custom/only-this');
	});

	it('skips malformed package.json files', () => {
		writeFileSync(join(tempDir, 'package.json'), '{ not valid json');
		const result = indexNpmDependencies(tempDir);
		assert.strictEqual(result.packageJsonCount, 1);
		assert.strictEqual(result.edges.length, 0);
	});
});
