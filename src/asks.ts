/** Phrases that mark a reply as waiting on the user's decision, in English and Spanish. */
const MARKERS =
	/needs your decision|decision needed|waiting (?:on|for) you|necesito que decidas|necesito tu (?:ok|decisi[oó]n|confirmaci[oó]n)/iu;

const FENCE = /^(`{3,}|~{3,})/;
const BULLET = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const HEADING = /^#{1,6}\s+/;
const CODE_SPAN = /(`+)[^`]+?\1/g;
/** Closing marks that may follow the `?` of a question. */
const CLOSERS = /[\s*_)"'”’»]+$/u;

/** Removes emphasis markers outside inline code spans, leaving `_` inside words alone. */
function stripEmphasis(line: string): string {
	let out = "";
	let last = 0;
	for (const match of line.matchAll(CODE_SPAN)) {
		out += stripMarks(line.slice(last, match.index)) + match[0];
		last = match.index + match[0].length;
	}
	return out + stripMarks(line.slice(last));
}

function stripMarks(text: string): string {
	return text.replace(/\*+/g, "").replace(/(^|[^\p{L}\p{N}_])_+|_+(?=[^\p{L}\p{N}_]|$)/gu, "$1");
}

/** Whether a cleaned line, with inline code removed, asks the user something. */
function isAsk(line: string): boolean {
	const prose = line.replace(CODE_SPAN, "");
	return MARKERS.test(prose) || prose.replace(CLOSERS, "").endsWith("?");
}

/**
 * Lines of a Markdown reply that wait on the user: questions and decision markers.
 * Fenced code, blockquotes, table rows and inline code are not prose and never count.
 */
export function detectOpenAsks(text: string): string[] {
	const asks: string[] = [];
	let fence: string | undefined;

	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const opening = FENCE.exec(line);
		if (fence) {
			if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && line === opening[1]) {
				fence = undefined;
			}
			continue;
		}
		if (opening) {
			fence = opening[1];
			continue;
		}
		if (line.startsWith(">") || line.startsWith("|")) continue;

		const cleaned = stripEmphasis(line.replace(HEADING, "").replace(BULLET, "")).trim();
		if (cleaned && isAsk(cleaned) && !asks.includes(cleaned)) asks.push(cleaned);
	}

	return asks;
}
