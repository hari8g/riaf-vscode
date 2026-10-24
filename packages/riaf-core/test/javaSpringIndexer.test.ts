import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert';
import { indexAllSpringServices, indexJavaSpringService } from '../src/javaSpringIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('JavaSpringIndexer', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trove-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => { try { rmSync(tempDir, { recursive: true }); } catch { } });

	it('detects @RestController endpoints', () => {
		const src = join(tempDir, 'src', 'main', 'java', 'com', 'example');
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, 'OrderController.java'), `
@RestController
@RequestMapping("/order")
public class OrderController {
  @GetMapping("/{id}")
  public OrderResponse getOrder(@PathVariable Long id) { return null; }

  @PostMapping
  public OrderResponse createOrder(@RequestBody OrderRequest req) { return null; }
}
`);
		const result = indexJavaSpringService(tempDir, tempDir);
		assert.ok(result.endpoints.length >= 2, 'Should detect at least 2 endpoints');
		const getEp = result.endpoints.find(e => e.httpMethod === 'GET');
		assert.ok(getEp, 'Should have a GET endpoint');
		assert.ok(getEp!.pathPattern.includes('/order'), 'Path should include /order');
	});

	it('detects @FeignClient declarations', () => {
		const src = join(tempDir, 'src', 'main', 'java');
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, 'OrderServiceClient.java'), `
@FeignClient(name = "staas-order-management")
public interface OrderServiceClient {
  @GetMapping("/order/{id}")
  OrderResponse getOrder(@PathVariable Long id);
}
`);
		const result = indexJavaSpringService(tempDir, tempDir);
		assert.ok(result.feignClients.length >= 1, 'Should detect FeignClient');
		assert.strictEqual(result.feignClients[0].targetService, 'staas-order-management');
	});

	it('indexAllSpringServices discovers services with corporate parent POM (no spring-boot string)', () => {
		const serviceDir = join(tempDir, 'application.yml', 'staas-order-management');
		const javaDir = join(serviceDir, 'src', 'main', 'java', 'com', 'bosch', 'staas');
		mkdirSync(javaDir, { recursive: true });
		writeFileSync(join(serviceDir, 'pom.xml'), `
<project>
  <parent>
    <groupId>com.bosch.staas</groupId>
    <artifactId>staas-parent</artifactId>
  </parent>
  <artifactId>staas-order-management</artifactId>
</project>
`);
		writeFileSync(join(javaDir, 'OrderController.java'), `
@RestController
@RequestMapping("/orders")
public class OrderController {
  @GetMapping("/{id}")
  public String getOrder() { return null; }
}
`);
		const result = indexAllSpringServices(tempDir);
		assert.ok(result.endpoints.length >= 1, 'Should index Java service without direct spring-boot dependency');
		assert.ok(result.serviceName.includes('staas-order-management') || result.endpoints.some(e => e.pathPattern.includes('/orders')));
	});

	it('indexAllSpringServices uses dirname(pom) not pom path as service directory', () => {
		const serviceDir = join(tempDir, 'services', 'staas-catalog-management');
		const javaDir = join(serviceDir, 'src', 'main', 'java');
		mkdirSync(javaDir, { recursive: true });
		writeFileSync(join(serviceDir, 'pom.xml'), `
<project>
  <artifactId>staas-catalog-management</artifactId>
  <dependencies>
    <dependency><artifactId>spring-web</artifactId></dependency>
  </dependencies>
</project>
`);
		writeFileSync(join(javaDir, 'CatalogController.java'), `
@RestController
public class CatalogController {
  @GetMapping("/catalog")
  public String list() { return null; }
}
`);
		const result = indexAllSpringServices(tempDir);
		assert.ok(result.endpoints.length >= 1, 'Nested pom.xml should resolve to parent service directory');
	});
});
