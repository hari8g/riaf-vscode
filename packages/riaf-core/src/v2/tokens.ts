/**
 * Token estimate used by the compiler's budgeter. Model tokenizers differ by ±15 %, so this is a
 * deliberate over-estimate for code (≈ 3.6 chars/token) that keeps packs under budget across models.
 */
export const estimateTokens = (text: string): number => (text ? Math.ceil(text.length / 3.6) : 0);

export const parseBudget = (raw: string | number | undefined, fallback = 24_000): number => {
	if (raw === undefined || raw === '') return fallback;
	if (typeof raw === 'number') return Math.max(256, Math.floor(raw));
	const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(raw);
	if (!m) return fallback;
	const n = Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1_000 : m[2].toLowerCase() === 'm' ? 1_000_000 : 1);
	return Math.max(256, Math.floor(n));
};
