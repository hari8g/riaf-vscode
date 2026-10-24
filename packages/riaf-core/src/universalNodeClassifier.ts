/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { basename } from 'path';
import type { ArchLayer, NodeType } from './universalImportExtractor.js';

type ClassifierRule = {
	test: (filePath: string, content: string) => boolean;
	nodeType: NodeType;
	layer: ArchLayer;
};

const RULES: ClassifierRule[] = [
	{
		test: (p, _c) => /(?:^|[/\\])(main|index|app|server|application)\.[a-z]+$/.test(p)
			&& !/test|spec|mock/i.test(p),
		nodeType: 'entry', layer: 'entry',
	},
	{
		test: (p) => /[\./](?:test|spec|e2e)\.[a-z]+$/.test(p) || /[/\\]__tests__[/\\]/.test(p),
		nodeType: 'test', layer: 'test',
	},
	{
		test: (p, c) => /[/\\](?:controllers?|routes?|handlers?|endpoints?)[/\\]/.test(p)
			|| /[/\\]\w+\.(?:controller|route|handler|router)\.[a-z]+$/.test(p)
			|| /@(?:RestController|Controller|GetMapping|PostMapping|RequestMapping)/.test(c),
		nodeType: 'controller', layer: 'api',
	},
	{
		test: (p, c) => /[/\\](?:services?|business|usecases?|domain)[/\\]/.test(p)
			|| /[/\\]\w+\.service\.[a-z]+$/.test(p)
			|| /@(?:Service|Injectable|Component)/.test(c),
		nodeType: 'service', layer: 'service',
	},
	{
		test: (p) => /[/\\](?:middleware|interceptors?)[/\\]/.test(p)
			|| /[/\\]\w+\.middleware\.[a-z]+$/.test(p),
		nodeType: 'middleware', layer: 'service',
	},
	{
		test: (p, c) => /[/\\](?:models?|entities|schemas?|domain)[/\\]/.test(p)
			|| /[/\\]\w+\.(?:model|entity|schema)\.[a-z]+$/.test(p)
			|| /@(?:Entity|Table|Document|Schema|Model)/.test(c),
		nodeType: 'model', layer: 'data',
	},
	{
		test: (p, c) => /[/\\](?:repositories?|daos?|stores?)[/\\]/.test(p)
			|| /[/\\]\w+\.(?:repository|dao|store)\.[a-z]+$/.test(p)
			|| /@(?:Repository|Dao)/.test(c),
		nodeType: 'repository', layer: 'data',
	},
	{
		test: (p) => /[/\\](?:config|configuration|settings)[/\\]/.test(p)
			|| /[/\\]\w+\.(?:config|cfg|settings|env)\.[a-z]+$/.test(p)
			|| /(?:^|[/\\])(?:\.env|config)\.[a-z]+$/.test(p),
		nodeType: 'config', layer: 'config',
	},
	{
		test: (p) => /[/\\]hooks?[/\\]/.test(p) || /[/\\]use[A-Z]\w+\.[a-z]+$/.test(p),
		nodeType: 'util', layer: 'service',
	},
	{
		test: (p) => /[/\\](?:utils?|helpers?|lib|common|shared)[/\\]/.test(p)
			|| /[/\\]\w+\.(?:utils?|helpers?)\.[a-z]+$/.test(p),
		nodeType: 'util', layer: 'service',
	},
];

export function classifyNode(filePath: string, content: string): { nodeType: NodeType; layer: ArchLayer } {
	for (const rule of RULES) {
		if (rule.test(filePath, content)) {
			return { nodeType: rule.nodeType, layer: rule.layer };
		}
	}
	return { nodeType: 'unknown', layer: 'service' };
}

export function isEntryPoint(filePath: string, _content: string, inDegree: number): boolean {
	const name = basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
	const entryNames = new Set(['main', 'index', 'app', 'server', 'application', 'program',
		'__main__', 'manage', 'wsgi', 'asgi', 'bootstrap']);
	return inDegree === 0 && (entryNames.has(name) || /^index\b/.test(name));
}
