import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { indexTerraformResources } from '../src/terraformIndexer.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TerraformIndexer', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trove-tf-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	it('indexes azurerm resources', () => {
		writeFileSync(join(tempDir, 'main.tf'), `
resource "azurerm_kubernetes_cluster" "aks_prod" {
  name = "staas-prod-aks"
  location = "East US"
}

resource "azurerm_redis_cache" "cache" {
  name = "staas-redis"
}
`);
		const result = indexTerraformResources(tempDir);
		assert.strictEqual(result.resources.length, 2);
		assert.ok(result.providers.includes('azurerm'));
		assert.strictEqual(result.fileCount, 1);
	});

	it('detects provider declarations', () => {
		writeFileSync(join(tempDir, 'providers.tf'), `
provider "azurerm" {
  features {}
}
provider "azuread" {}
`);
		const result = indexTerraformResources(tempDir);
		assert.ok(result.providers.includes('azurerm'));
		assert.ok(result.providers.includes('azuread'));
	});
});
