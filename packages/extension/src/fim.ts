/** Fill-in-the-middle prompt shared by inline completion and quick edit. */
export function buildFimPrompt(opts: { prefix: string; suffix: string; context?: string; instruction?: string }): string {
	const lines: string[] = [];
	if (opts.context?.trim()) { lines.push('<codebase_context>', opts.context.trim(), '</codebase_context>'); }
	if (opts.instruction?.trim()) { lines.push('<instruction>', opts.instruction.trim(), '</instruction>'); }
	lines.push('<fim_prefix>', opts.prefix, '<fim_suffix>', opts.suffix, '<fim_middle>');
	return lines.join('\n');
}
