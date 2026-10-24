import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { indexKubernetesManifests } from '../src/kubernetesYamlIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('KubernetesYamlIndexer', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trove-k8s-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	it('indexes Deployment manifests', () => {
		writeFileSync(join(tempDir, 'deployment.yaml'), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: staas-order
  namespace: prod
spec:
  template:
    spec:
      containers:
      - name: app
        image: staas/order:1.0.0
`);
		const resources = indexKubernetesManifests(tempDir);
		assert.ok(resources.length >= 1);
		assert.strictEqual(resources[0].kind, 'Deployment');
		assert.strictEqual(resources[0].name, 'staas-order');
	});
});
