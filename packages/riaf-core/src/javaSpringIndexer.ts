/*---------------------------------------------------------------------------
 * JavaSpringIndexer — parses @RestController, @FeignClient, and port config
 * from Java/Spring Boot service files. No tree-sitter; regex over .java files.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { FeignClientEdge, SpringEndpoint } from './repoIntelligenceDb.js';

const HTTP_METHOD_MAP: Record<string, string> = {
	'GetMapping': 'GET',
	'PostMapping': 'POST',
	'PutMapping': 'PUT',
	'DeleteMapping': 'DELETE',
	'PatchMapping': 'PATCH',
};

function deriveServiceName(workspaceRoot: string, applicationYmlPath: string | null): string {
	if (applicationYmlPath) {
		try {
			const yml = readFileSync(applicationYmlPath, 'utf8');
			const match = yml.match(/spring:\s*\n\s+application:\s*\n\s+name:\s*([^\n]+)/);
			if (match) return match[1].trim();
		} catch { /* ignore */ }
	}
	return basename(workspaceRoot) || 'unknown-service';
}

function collectJavaFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 10) return results;
	const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'out', '.gradle']);
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP.has(entry)) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) collectJavaFiles(full, results, depth + 1);
		else if (entry.endsWith('.java')) results.push(full);
	}
	return results;
}

function findApplicationYml(serviceDir: string): string | null {
	const candidates = [
		join(serviceDir, 'src', 'main', 'resources', 'application.yml'),
		join(serviceDir, 'src', 'main', 'resources', 'application.yaml'),
		join(serviceDir, 'application.yml'),
	];
	for (const c of candidates) {
		try { statSync(c); return c; } catch { /* continue */ }
	}
	return null;
}

function extractClassLevelPath(source: string): string {
	const match = source.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
	return match ? match[1] : '';
}

function extractMethodPath(annotation: string): string {
	const match = annotation.match(/["']([^"']+)["']/);
	return match ? match[1] : '';
}

export type JavaIndexResult = {
	endpoints: SpringEndpoint[];
	feignClients: FeignClientEdge[];
	serviceName: string;
};

export function indexJavaSpringService(workspaceRoot: string, serviceDir: string): JavaIndexResult {
	const appYml = findApplicationYml(serviceDir);
	const serviceName = deriveServiceName(serviceDir, appYml);
	const javaFiles = collectJavaFiles(serviceDir);

	const endpoints: SpringEndpoint[] = [];
	const feignClients: FeignClientEdge[] = [];

	for (const filePath of javaFiles) {
		let source: string;
		try { source = readFileSync(filePath, 'utf8'); } catch { continue; }

		const relPath = relative(workspaceRoot, filePath).replace(/\\/g, '/');

		const feignMatches = source.matchAll(/@FeignClient\s*\(\s*(?:name\s*=\s*|value\s*=\s*)?["']([^"']+)["']/g);
		for (const m of feignMatches) {
			const targetService = m[1];
			const interfaceMatch = source.match(/public\s+interface\s+(\w+)/);
			const interfaceName = interfaceMatch ? interfaceMatch[1] : (basename(relPath, '.java') || 'Unknown');
			feignClients.push({ callerService: serviceName, targetService, interfaceName, filePath: relPath });
		}

		if (!/@RestController/.test(source) && !/@Controller/.test(source)) continue;

		const classMatch = source.match(/(?:public\s+)?class\s+(\w+)/);
		const controllerClass = classMatch ? classMatch[1] : 'Unknown';

		const classPath = extractClassLevelPath(source);
		// Annotations before the class declaration are class-level (e.g. @RequestMapping on the controller).
		const classDeclIndex = classMatch?.index ?? 0;

		// Parentheses are optional: `@GetMapping` with no arguments maps to the class-level path.
		const methodAnnotationRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b(?:\s*\(([^)]*)\))?/g;
		let methodMatch: RegExpExecArray | null;

		while ((methodMatch = methodAnnotationRegex.exec(source)) !== null) {
			if (methodMatch.index < classDeclIndex) continue;
			const annotationName = methodMatch[1];
			const annotationBody = methodMatch[2] ?? '';
			const httpMethod = HTTP_METHOD_MAP[annotationName] ?? 'GET';

			const methodPath = extractMethodPath(annotationBody);
			const fullPath = methodPath
				? classPath + (methodPath.startsWith('/') ? methodPath : '/' + methodPath)
				: classPath;

			const afterAnnotation = source.slice(methodMatch.index + methodMatch[0].length);
			const handlerMatch = afterAnnotation.match(/\s+(?:public|private|protected)\s+\S+\s+(\w+)\s*\(/);
			const handlerMethod = handlerMatch ? handlerMatch[1] : 'unknown';

			const paramSection = afterAnnotation.match(/\(([^)]*)\)/)?.[1] ?? '';
			const requestDtoMatch = paramSection.match(/@RequestBody\s+(\w+)/);
			const requestDto = requestDtoMatch ? requestDtoMatch[1] : undefined;

			const beforeHandler = source.slice(0, methodMatch.index);
			const returnTypeMatch = beforeHandler.split('\n').at(-1)?.match(/\s+(\w+(?:<[^>]+>)?)\s+\w+\s*\(/) ?? null;
			const responseDto = returnTypeMatch ? returnTypeMatch[1] : undefined;

			endpoints.push({
				serviceName, filePath: relPath, httpMethod,
				pathPattern: fullPath || '/',
				controllerClass, handlerMethod,
				requestDto, responseDto,
			});
		}
	}

	return { endpoints, feignClients, serviceName };
}

export function indexAllSpringServices(workspaceRoot: string): JavaIndexResult {
	const allEndpoints: SpringEndpoint[] = [];
	const allFeignClients: FeignClientEdge[] = [];
	const serviceNames: string[] = [];

	const pomFiles: string[] = [];
	function findPoms(dir: string, depth = 0) {
		if (depth > 8) return;
		const SKIP = new Set(['node_modules', '.git', 'target', 'build', '.gradle']);
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return; }
		for (const entry of entries) {
			if (SKIP.has(entry)) continue;
			const full = join(dir, entry);
			let stat;
			try { stat = statSync(full); } catch { continue; }
			if (stat.isDirectory()) findPoms(full, depth + 1);
			else if (entry === 'pom.xml') pomFiles.push(full);
		}
	}
	findPoms(workspaceRoot);

	const processedDirs = new Set<string>();
	for (const pom of pomFiles) {
		let content: string;
		try {
			content = readFileSync(pom, 'utf8');
		} catch { continue; }

		const serviceDir = dirname(pom);

		const isSpringProject =
			content.includes('spring-boot') ||
			content.includes('springframework') ||
			content.includes('spring-web') ||
			content.includes('spring-mvc');

		const hasSrcMainJava = (() => {
			try {
				statSync(join(serviceDir, 'src', 'main', 'java'));
				return true;
			} catch { return false; }
		})();

		if (!isSpringProject && !hasSrcMainJava) continue;

		if (processedDirs.has(serviceDir)) continue;
		processedDirs.add(serviceDir);

		const result = indexJavaSpringService(workspaceRoot, serviceDir);
		allEndpoints.push(...result.endpoints);
		allFeignClients.push(...result.feignClients);
		if (!serviceNames.includes(result.serviceName)) serviceNames.push(result.serviceName);
	}

	if (pomFiles.length === 0) {
		const result = indexJavaSpringService(workspaceRoot, workspaceRoot);
		allEndpoints.push(...result.endpoints);
		allFeignClients.push(...result.feignClients);
		serviceNames.push(result.serviceName);
	}

	return {
		endpoints: allEndpoints,
		feignClients: allFeignClients,
		serviceName: serviceNames.join(', '),
	};
}
