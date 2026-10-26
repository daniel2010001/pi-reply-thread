/** Phrases that mark a reply as waiting on the user's decision, in English and Spanish. */
const MARKERS =
	/needs your decision|decision needed|waiting (?:on|for) you|necesito que decidas|necesito tu (?:ok|decisi[oó]n|confirmaci[oó]n)/iu;

const FENCE = /^(`{3,}|~{3,})/;
const BULLET = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const HEADING = /^#{1,6}\s+/;
const CODE_SPAN = /(`+)[^`]+?\1/g;
/** Double-quoted spans: a marker inside one is being mentioned, not addressed to the user. */
const QUOTED = /"[^"]*"|“[^”]*”|«[^»]*»/gu;
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
	return MARKERS.test(prose.replace(QUOTED, "")) || prose.replace(CLOSERS, "").endsWith("?");
}

/**
 * How asks are found. `section`: when a reply has a decision section (a marker heading with an ask
 * under it), only that section's asks count. `all`: every ask of the reply counts.
 */
export type AskMode = "section" | "all";

/** A list marker without its checkbox, to measure where the item's content starts. */
const MARK = /^(?:[-*+]|\d+[.)])\s+/;

/** A line that may ask, with where it sits in the reply. */
interface Candidate {
	text: string;
	/** `item` is a top-level list item, `nested` one under it, `heading` a marker heading. */
	kind: "heading" | "item" | "nested" | "line";
	/** The marker section the line is in, numbered from 0; undefined outside one. */
	section?: number;
	/** Whether the line asks by itself: it ends in `?` or holds a decision marker. */
	asks: boolean;
}

/** Leading columns of a line, a tab counting 4. */
function indentOf(raw: string): number {
	let columns = 0;
	for (const char of raw) {
		if (char === " ") columns += 1;
		else if (char === "\t") columns += 4;
		else break;
	}
	return columns;
}

/**
 * The lines of a reply that may ask: every line that asks by itself, every top-level item of a marker
 * section and every marker heading. Fenced code, blockquotes, table rows and inline code are not prose.
 */
function candidates(text: string): Candidate[] {
	const found: Candidate[] = [];
	let fence: string | undefined;
	let section: number | undefined;
	let sections = 0;
	/** Content column of the latest top-level list item: an item indented that far is nested in it. */
	let list: number | undefined;

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

		// A heading that ends in `?` titles a section ("## Why not a model?"); only a marker in it asks.
		const heading = HEADING.test(line);
		const cleaned = stripEmphasis(line.replace(HEADING, "").replace(BULLET, "")).trim();
		if (heading) {
			list = undefined;
			const marker = MARKERS.test(cleaned.replace(CODE_SPAN, "").replace(QUOTED, ""));
			section = marker ? sections++ : undefined;
			if (marker && cleaned) found.push({ text: cleaned, kind: "heading", section, asks: true });
			continue;
		}
		const indent = indentOf(raw);
		let kind: Candidate["kind"] = "line";
		if (BULLET.test(line)) {
			kind = indent >= 4 || (list !== undefined && indent >= list) ? "nested" : "item";
			if (kind === "item") list = indent + (MARK.exec(line)?.[0].length ?? 0);
		} else if (line && list !== undefined && indent < list) list = undefined;
		if (!cleaned) continue;
		const asks = isAsk(cleaned);
		if (asks || (kind === "item" && section !== undefined)) found.push({ text: cleaned, kind, section, asks });
	}

	return found;
}

function unique(texts: string[]): string[] {
	return [...new Set(texts)];
}

/**
 * Today's rules: every line that asks by itself and every top-level item of a marker section; a marker
 * heading asks only while its section has no ask of its own.
 */
function allAsks(found: readonly Candidate[]): Candidate[] {
	const asks = found.filter(
		(line) => line.kind !== "heading" && (line.asks || (line.kind === "item" && line.section !== undefined)),
	);
	const titled = new Set(asks.flatMap((line) => (line.section === undefined ? [] : [line.section])));
	return found.filter((line) => asks.includes(line) || (line.kind === "heading" && !titled.has(line.section as number)));
}

/** The asks of the decision sections: their top-level items and their other lines that ask, not nested items. */
function sectionAsks(found: readonly Candidate[]): Candidate[] {
	return found.filter((line) => line.section !== undefined && (line.kind === "item" || (line.kind === "line" && line.asks)));
}

/** The asks of a reply in a mode, and how many asks `all` would add outside the decision sections. */
function scan(text: string, mode: AskMode): { asks: string[]; untracked: number } {
	const found = candidates(text);
	const all = unique(allAsks(found).map((line) => line.text));
	const section = sectionAsks(found);
	if (mode === "all" || !section.length) return { asks: all, untracked: 0 };
	const tracked = unique(section.map((line) => line.text));
	const decision = new Set(section.map((line) => line.section));
	const outside = allAsks(found).filter((line) => !decision.has(line.section) && !tracked.includes(line.text));
	return { asks: tracked, untracked: unique(outside.map((line) => line.text)).length };
}

/**
 * Lines of a Markdown reply that wait on the user: questions and decision markers, cleaned of bullets,
 * heading marks and emphasis, in order and without duplicates. Fenced code, blockquotes, table rows and
 * inline code are not prose and never count; a heading ending in `?` titles a section.
 * In a section headed by a marker, until the next heading, every top-level list item asks, even without
 * `?`; nested items ask only by their own `?`. The marker heading asks only while its section has no ask.
 * In `section` mode, a reply with such a section asks only that section's top-level items and its
 * other lines that ask; asks elsewhere in the reply are not tracked.
 */
export function detectOpenAsks(text: string, mode: AskMode = "section"): string[] {
	return scan(text, mode).asks;
}

/** How many asks `detectOpenAsks` leaves untracked outside the decision section in `section` mode; 0 in `all`. */
export function untrackedAsks(text: string, mode: AskMode = "section"): number {
	return scan(text, mode).untracked;
}
