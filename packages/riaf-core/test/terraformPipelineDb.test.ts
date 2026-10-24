import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { hashWorkspaceRoot, RepoIntelligenceDb } from '../src/repoIntelligenceDb.js';
import { indexTerraformResources } from '../src/terraformIndexer.js';
import { indexGitlabPipelines } from '../src/gitlabCiIndexer.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

describe('Trove - Terraform/Pipeline DB persistence', () => {

	let db: RepoIntelligenceDb;
	let dbPath: string;
	let tempDir: string;
	const workspaceHash = hashWorkspaceRoot('/tmp/terraform-pipeline-test');

	beforeEach(async () => {
		dbPath = join(tmpdir(), `trove-tf-pipeline-db-${randomBytes(8).toString('hex')}.db`);
		db = new RepoIntelligenceDb(dbPath);
		await db.init();

		tempDir = join(tmpdir(), `trove-tf-pipeline-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		await db.upsertProfile(workspaceHash, {
			workspaceRoot: tempDir,
			lastScannedAt: Date.now(),
			languageStack: [],
			frameworks: [],
			packageManagers: [],
			buildCommands: [],
			testCommands: [],
			lintCommands: [],
			typecheckCommands: [],
			projectPurpose: null,
			architectureSummary: null,
			fileCount: 0,
			totalLoc: 0,
			isStale: false,
		}, []);
	});

	afterEach(async () => {
		await db.close();
		try { rmSync(dbPath); } catch { }
		try { rmSync(tempDir, { recursive: true }); } catch { }
	});

	it('persists and reloads terraform index', async () => {
		writeFileSync(join(tempDir, 'main.tf'), `
resource "azurerm_kubernetes_cluster" "aks_prod" {
  name = "staas-prod-aks"
}
`);
		const indexed = indexTerraformResources(tempDir);
		await db.replaceTerraformIndex(workspaceHash, indexed);

		const resources = await db.getTerraformResources(workspaceHash);
		const meta = await db.getTerraformIndexMeta(workspaceHash);

		assert.strictEqual(resources.length, 1);
		assert.strictEqual(resources[0].resourceType, 'azurerm_kubernetes_cluster');
		assert.ok(meta);
		assert.strictEqual(meta!.fileCount, 1);
		assert.ok(meta!.providers.includes('azurerm'));
	});

	it('persists and reloads pipeline index', async () => {
		writeFileSync(join(tempDir, '.gitlab-ci.yml'), `
stages:
  - build
  - deploy

build-job:
  stage: build
  script: npm run build

deploy-job:
  stage: deploy
  script: npm run deploy
  when: manual
`);
		const indexed = indexGitlabPipelines(tempDir);
		await db.replacePipelineIndex(workspaceHash, indexed);

		const jobs = await db.getPipelineJobs(workspaceHash);
		const meta = await db.getPipelineIndexMeta(workspaceHash);

		assert.ok(jobs.length >= 2);
		assert.ok(meta);
		assert.strictEqual(meta!.hasManualGates, true);
		assert.ok(jobs.some(j => j.stage === 'build'));
	});
});
