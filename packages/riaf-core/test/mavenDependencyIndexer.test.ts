import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { indexMavenDependencies } from '../src/mavenDependencyIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('MavenDependencyIndexer', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trove-maven-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	it('parses dependencies from pom.xml', async () => {
		writeFileSync(join(tempDir, 'pom.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <dependencies>
    <dependency>
      <groupId>com.example</groupId>
      <artifactId>ms-data-model</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`);
		const result = await indexMavenDependencies(tempDir);
		assert.strictEqual(result.pomCount, 1);
		assert.ok(result.deps.some(d => d.artifactId === 'ms-data-model'));
	});
});
