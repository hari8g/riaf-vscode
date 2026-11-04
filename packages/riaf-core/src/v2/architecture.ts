/**
 * Architecture facts and repo conventions (Pillar 1 "derive architecture facts once per package").
 * Reads manifests and config files directly; combines them with the index's workspace profile and UCG.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RiafIndex } from '../riafIndex.js';

export interface PackageInfo { name: string; path: string; kind: 'npm' | 'maven' | 'gradle' | 'python' | 'go' | 'cargo' | 'dotnet' | 'cmake' | 'bazel' }
export interface ArchitectureFacts {
	monorepo?: 'npm-workspaces' | 'pnpm' | 'yarn-workspaces' | 'lerna' | 'nx' | 'turbo' | 'bazel' | 'gradle-multi' | 'maven-multi' | 'cargo-workspace' | 'go-workspace';
	packages: PackageInfo[];
	entryPoints: string[];
	languages: string[];
	frameworks: string[];
	build: string;
	test: string;
	lint: string;
	typecheck: string;
	styleNotes: string[];
	testLayout: 'co-located' | 'separate-dir' | 'mixed' | 'none';
	generatedPatterns: string[];
	summary: string;
}

const readJson = (p: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

const MANIFESTS: [RegExp, PackageInfo['kind']][] = [
	[/(^|\/)package\.json$/, 'npm'], [/(^|\/)pom\.xml$/, 'maven'], [/(^|\/)build\.gradle(\.kts)?$/, 'gradle'],
	[/(^|\/)(pyproject\.toml|setup\.py)$/, 'python'], [/(^|\/)go\.mod$/, 'go'], [/(^|\/)Cargo\.toml$/, 'cargo'],
	[/\.csproj$/, 'dotnet'], [/(^|\/)CMakeLists\.txt$/, 'cmake'], [/(^|\/)BUILD(\.bazel)?$/, 'bazel'],
];

export function manifestKind(path: string): PackageInfo['kind'] | undefined {
	return MANIFESTS.find(([re]) => re.test(path))?.[1];
}

/** `.gitattributes` linguist-generated / linguist-vendored patterns. */
export function generatedPatternsFrom(gitattributes: string): string[] {
	const out: string[] = [];
	for (const line of gitattributes.split('\n')) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;
		const [pattern, ...attrs] = t.split(/\s+/);
		if (attrs.some(a => /^linguist-(generated|vendored)(=true)?$/.test(a))) out.push(pattern);
	}
	return out;
}

export function globToRegExp(glob: string): RegExp {
	let g = glob.replace(/^\//, '');
	const anchored = glob.startsWith('/') || g.includes('/');
	g = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
	if (g.endsWith('/')) g += '.*';
	return new RegExp(`${anchored ? '^' : '(^|/)'}${g}(/.*)?$`);
}

export async function deriveArchitecture(index: RiafIndex): Promise<ArchitectureFacts> {
	const root = index.workspaceRoot;
	const profile = await index.getWorkspaceProfile();
	const files = (await index.db.getFileMetadata(index.workspaceHash)).map(f => f.filePath);
	const fileSet = new Set(files);

	// Packages from manifests (skip nested node_modules / fixtures).
	const packages: PackageInfo[] = [];
	for (const f of files) {
		const kind = manifestKind(f);
		if (!kind || /(^|\/)(node_modules|fixtures?|vendor|third_party)\//.test(f)) continue;
		const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
		let name = dir === '.' ? '(root)' : dir.split('/').pop()!;
		if (kind === 'npm') name = String(readJson(join(root, f))?.name ?? name);
		if (kind === 'maven') name = /<artifactId>([^<]+)<\/artifactId>/.exec(readText(join(root, f)).replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1] ?? name;
		if (kind === 'go') name = /^module\s+(\S+)/m.exec(readText(join(root, f)))?.[1] ?? name;
		if (kind === 'cargo' || kind === 'python') name = /^name\s*=\s*"([^"]+)"/m.exec(readText(join(root, f)))?.[1] ?? name;
		if (!packages.some(p => p.path === dir && p.kind === kind)) packages.push({ name, path: dir, kind });
	}

	// Monorepo tool.
	const rootPkg = readJson(join(root, 'package.json'));
	let monorepo: ArchitectureFacts['monorepo'];
	if (existsSync(join(root, 'nx.json'))) monorepo = 'nx';
	else if (existsSync(join(root, 'turbo.json'))) monorepo = 'turbo';
	else if (existsSync(join(root, 'lerna.json'))) monorepo = 'lerna';
	else if (existsSync(join(root, 'pnpm-workspace.yaml'))) monorepo = 'pnpm';
	else if (rootPkg?.workspaces) monorepo = existsSync(join(root, 'yarn.lock')) ? 'yarn-workspaces' : 'npm-workspaces';
	else if (existsSync(join(root, 'WORKSPACE')) || existsSync(join(root, 'MODULE.bazel'))) monorepo = 'bazel';
	else if (/include\s*\(?['"]/.test(readText(join(root, 'settings.gradle')) + readText(join(root, 'settings.gradle.kts')))) monorepo = 'gradle-multi';
	else if (/<modules>/.test(readText(join(root, 'pom.xml')))) monorepo = 'maven-multi';
	else if (/\[workspace\]/.test(readText(join(root, 'Cargo.toml')))) monorepo = 'cargo-workspace';
	else if (existsSync(join(root, 'go.work'))) monorepo = 'go-workspace';

	// Conventions: lint / format configs.
	const styleNotes: string[] = [];
	const has = (re: RegExp) => files.find(f => re.test(f) && !f.includes('/node_modules/'));
	const eslint = has(/(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.(js|mjs|cjs|ts))$/) ?? (rootPkg?.eslintConfig ? 'package.json#eslintConfig' : undefined);
	if (eslint) styleNotes.push(`ESLint config at ${eslint}`);
	const prettier = has(/(^|\/)(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/) ?? (rootPkg?.prettier ? 'package.json#prettier' : undefined);
	if (prettier) styleNotes.push(`Prettier formatting (${prettier})`);
	const pyproject = readText(join(root, 'pyproject.toml'));
	if (/\[tool\.ruff/.test(pyproject) || has(/(^|\/)ruff\.toml$/)) styleNotes.push('Ruff lint/format for Python');
	if (/\[tool\.black/.test(pyproject)) styleNotes.push('Black formatting for Python');
	if (/\[tool\.mypy/.test(pyproject) || has(/(^|\/)mypy\.ini$/)) styleNotes.push('mypy type checking');
	if (has(/(^|\/)checkstyle.*\.xml$/)) styleNotes.push('Checkstyle for Java');
	if (has(/(^|\/)\.clang-format$/)) styleNotes.push('clang-format for C/C++');
	const editorconfig = readText(join(root, '.editorconfig'));
	if (editorconfig) {
		const indent = /indent_style\s*=\s*(\w+)/.exec(editorconfig)?.[1];
		const size = /indent_size\s*=\s*(\d+)/.exec(editorconfig)?.[1];
		if (indent) styleNotes.push(`EditorConfig: indent with ${indent}${size ? ` (${size})` : ''}`);
	}
	const tsconfig = readJson(join(root, 'tsconfig.json')) ?? readJson(join(root, 'tsconfig.base.json'));
	const co = tsconfig?.compilerOptions as Record<string, unknown> | undefined;
	if (co?.strict) styleNotes.push('TypeScript strict mode');
	if (typeof co?.module === 'string' && /node(next|16)|esnext/i.test(co.module)) styleNotes.push(`TypeScript module ${co.module} (ESM: use .js extensions in relative imports)`);
	if (rootPkg?.type === 'module') styleNotes.push('package type "module" (ESM)');

	// Test layout.
	const tests = files.filter(f => /\.(test|spec)\.[a-z]+$|Test\.(java|kt)$|_test\.(py|go|rs)$|(^|\/)test_[^/]+\.py$/.test(f));
	const separate = tests.filter(t => /(^|\/)(tests?|__tests__|spec|src\/test)\//.test(t)).length;
	const testLayout: ArchitectureFacts['testLayout'] = !tests.length ? 'none' : separate === tests.length ? 'separate-dir' : separate === 0 ? 'co-located' : 'mixed';
	if (tests.length) styleNotes.push(`Tests are ${testLayout === 'co-located' ? 'next to the source (*.test.*)' : testLayout === 'separate-dir' ? 'in separate test directories' : 'both co-located and in test directories'}`);

	const generatedPatterns = generatedPatternsFrom(readText(join(root, '.gitattributes')));

	// Entry points from the UCG.
	let entryPoints: string[] = [];
	try { entryPoints = (await index.getGraph()).nodes.filter(n => n.isEntryPoint && !/(^|\/)(test|tests|__tests__|fixtures?|examples?|samples?)\//.test(n.filePath)).map(n => n.filePath).slice(0, 15); } catch { /* no graph */ }
	if (!entryPoints.length) entryPoints = files.filter(f => /(^|\/)(main|index|app|server|cli)\.(ts|js|py|go|java)$|(^|\/)__main__\.py$|Application\.java$/.test(f) && !/test/i.test(f)).slice(0, 10);

	const cmd = (list: { command: string }[] | undefined) => list?.[0]?.command ?? '';
	const languages = profile?.languageStack ?? [];
	const frameworks = (profile?.frameworks ?? []).map(f => f.name);
	const summary = profile?.architectureSummary
		?? [
			languages.length ? `${languages.slice(0, 4).join('/')} codebase` : 'Codebase',
			monorepo ? `organised as a ${monorepo} monorepo with ${packages.length} packages` : packages.length > 1 ? `with ${packages.length} build manifests` : '',
			frameworks.length ? `using ${frameworks.slice(0, 5).join(', ')}` : '',
			entryPoints.length ? `; entry points ${entryPoints.slice(0, 3).join(', ')}` : '',
		].filter(Boolean).join(' ') + '.';
	void fileSet;
	return {
		monorepo, packages: packages.slice(0, 60), entryPoints, languages, frameworks,
		build: cmd(profile?.buildCommands), test: cmd(profile?.testCommands), lint: cmd(profile?.lintCommands), typecheck: cmd(profile?.typecheckCommands),
		styleNotes, testLayout, generatedPatterns, summary,
	};
}

export function formatConventions(a: ArchitectureFacts): string {
	return [
		`Languages: ${a.languages.join(', ') || 'unknown'}`,
		a.frameworks.length ? `Frameworks: ${a.frameworks.join(', ')}` : '',
		a.build ? `Build: \`${a.build}\`` : '', a.test ? `Test: \`${a.test}\`` : '', a.lint ? `Lint: \`${a.lint}\`` : '', a.typecheck ? `Typecheck: \`${a.typecheck}\`` : '',
		...a.styleNotes.map(s => `- ${s}`),
	].filter(Boolean).join('\n');
}

export function formatArchitecture(a: ArchitectureFacts): string {
	return [
		a.summary,
		a.monorepo ? `Monorepo: ${a.monorepo}` : '',
		a.packages.length ? `Packages:\n${a.packages.slice(0, 30).map(p => `- ${p.name} (${p.kind}) — ${p.path}`).join('\n')}` : '',
		a.entryPoints.length ? `Entry points: ${a.entryPoints.join(', ')}` : '',
		a.generatedPatterns.length ? `Generated/vendored (do not edit): ${a.generatedPatterns.join(', ')}` : '',
	].filter(Boolean).join('\n');
}

/** Directory listing helper used for `files_listed` known facts. */
export function listDir(root: string, rel: string): string[] {
	try { return readdirSync(join(root, rel), { withFileTypes: true }).map(d => d.name + (d.isDirectory() ? '/' : '')).sort(); } catch { return []; }
}
