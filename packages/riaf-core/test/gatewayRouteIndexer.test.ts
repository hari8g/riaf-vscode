import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { indexGatewayRoutes } from '../src/gatewayRouteIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('GatewayRouteIndexer', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trove-gateway-test-${Date.now()}`);
		mkdirSync(join(tempDir, 'src', 'main', 'resources'), { recursive: true });
	});

	afterEach(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	it('parses Spring Cloud Gateway routes', () => {
		writeFileSync(join(tempDir, 'src', 'main', 'resources', 'application.yml'), `
spring:
  cloud:
    gateway:
      routes:
      - id: order-route
        uri: lb://staas-order-management
        predicates:
        - Path=/order/**
`);
		const routes = indexGatewayRoutes(tempDir);
		assert.ok(routes.length >= 1);
		assert.strictEqual(routes[0].targetService, 'staas-order-management');
		assert.ok(routes[0].pathPredicate.includes('/order'));
	});
});
