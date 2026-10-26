import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildThreads, type Reply, type Thread } from "./threads.ts";

/** Custom entry type of the central's dismiss and link actions, written with `pi.appendEntry`. */
export const ASK_ENTRY = "reply-thread.ask";

/** `ask` is the newer question, `continues` the older one it repeats. Both are unique question IDs. */
export type AskAction =
	| { action: "dismiss" | "reopen"; ask: string }
	| { action: "link" | "unlink"; ask: string; continues: string };

/** The IDs of one open ask of a reply. */
export interface QuestionId {
	/** Ordered ID, `P<prompt>.R<reply>.Q<n>`, n the 1-based position in `Reply.openAsks`. */
	ordinal: string;
	/** Unique ID, `<reply entry ID>.<n>`. */
	id: string;
	text: string;
}

export interface Ask extends QuestionId {
	reply: Reply;
	thread: Thread;
	/** Position on the branch, oldest first; orders the asks of one reply too. */
	seq: number;
}

/** One open row of the central: an ask alone, or the newest member of a chain. */
export interface PendingAsk extends Ask {
	/** Older members of its chain, oldest first; empty for an ask without links. */
	chain: Ask[];
	/** Unique ID of the older ask it continues, the link `u` removes. */
	continues?: string;
	/** An older open ask that looks like a repeat, for an ask without links. Never linked by itself. */
	suggestion?: Ask;
}

/** How a closed ask closed: a later prompt cited it, with the answer it gave, or the central dismissed it. */
export type ClosedBy = { kind: "answer"; prompt: Thread; text: string } | { kind: "dismiss" };

/** One closed row: an ask alone, or the newest member of a chain, with how the chain closed. */
export interface ClosedAsk {
	ask: Ask;
	/** Older members of its chain, oldest first; empty for an ask without links. */
	chain: Ask[];
	closedBy: ClosedBy;
}

/** The asks of a branch: the open rows of the central and the closed ones. */
export interface AskState {
	pending: PendingAsk[];
	closed: ClosedAsk[];
}

export function questionIds(reply: Reply): QuestionId[] {
	return reply.openAsks.map((text, index) => ({
		ordinal: `${reply.ordinal}.Q${index + 1}`,
		id: `${reply.entryId}.${index + 1}`,
		text,
	}));
}

/** Unique IDs of the asks still open: each row and the older members of its chain. */
export function openIds(pending: readonly (QuestionId & { chain?: readonly QuestionId[] })[]): Set<string> {
	return new Set(pending.flatMap((row) => [row.id, ...(row.chain ?? []).map((member) => member.id)]));
}

/** Lowercase, without inline code and punctuation, spaces collapsed: the text two repeats share. */
export function normalizeAsk(text: string): string {
	return text
		.toLowerCase()
		.replace(/(`+)[^`]+?\1/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function words(text: string): Set<string> {
	return new Set(text.split(" ").filter((word) => [...word].length > 3));
}

/** Same normalized text, or word sets (words longer than 3 letters) with a Jaccard index of 0.6 or more. */
export function similarAsks(a: string, b: string): boolean {
	const left = normalizeAsk(a);
	const right = normalizeAsk(b);
	if (!left || !right) return false;
	if (left === right) return true;
	const one = words(left);
	const two = words(right);
	const shared = [...one].filter((word) => two.has(word)).length;
	const union = one.size + two.size - shared;
	return union > 0 && shared / union >= 0.6;
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a prompt cites the ask by its ordered ID (any case) or its unique ID, not by a longer ID. */
function cites(prompt: string, ask: Ask): boolean {
	const ordinal = new RegExp(`(?<![\\p{L}\\p{N}])${escape(ask.ordinal)}(?!\\p{N})`, "iu");
	const unique = new RegExp(`(?<![0-9a-zA-Z])${escape(ask.id)}(?![0-9])`, "u");
	return ordinal.test(prompt) || unique.test(prompt);
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

/** The answer to the quote on trimmed line `at`: the `R:` line under it, the text after its `arrow`, or the next plain line. */
function answerAt(prompt: string, lines: readonly string[], at: number, arrow: number): string {
	const under = lines[at + 1];
	if (under?.startsWith("R:")) return under.slice(2).trim();
	if (arrow >= 0) return lines[at].slice(arrow + 1).trim();
	return lines.slice(at + 1).find((line) => line && !line.startsWith(">")) ?? firstLine(prompt);
}

/**
 * What a prompt answers to an ask it cites, trimmed: the `R:` line right under the cited quote, the text
 * after `→` on the quote line, or the first line after the quote that is neither a quote nor empty.
 * A prompt that cites the ask outside a quote, or has nothing after the quote, answers its first line.
 * Lines in `skip` (a quote that closed an ask by its text) do not count as citing it.
 */
export function answerOf(prompt: string, ask: Ask, skip: ReadonlySet<number> = new Set()): string {
	const lines = prompt.split("\n").map((line) => line.trim());
	const at = lines.findIndex((line, index) => !skip.has(index) && cites(line, ask));
	const quote = lines[at];
	if (!quote?.startsWith(">")) return firstLine(prompt);
	// The ask itself may hold a `→`, so take the one right after its text when the quote keeps it.
	const known = quote.indexOf(`${ask.text} →`);
	return answerAt(prompt, lines, at, known >= 0 ? known + ask.text.length + 1 : quote.indexOf("→"));
}

/** `> <ordered or unique ID>: <text>`, the quote the central pastes; the text starts at `start`. */
const QUOTE = /^>\s*(P\d+\.R\d+\.Q\d+|[0-9a-f]{8}\.\d+)\s*:\s*/i;

/**
 * The ask a trimmed quote line carries by its text, and where its answer's `→` is: the text up to a
 * `→` (the last one first) or the whole text, compared with `normalizeAsk`. Among the asks with that
 * text, the open one the quote's ID names, else the newest open one; `ask` is undefined when all of
 * them are closed. Undefined when the line is no quote or its text matches no ask.
 */
function quotedAsk(
	line: string,
	asks: readonly Ask[],
	isOpen: (ask: Ask) => boolean,
): { ask?: Ask; arrow: number } | undefined {
	const quote = QUOTE.exec(line);
	if (!quote) return undefined;
	const start = quote[0].length;
	const arrows = [...line.slice(start).matchAll(/→/g)].map((match) => start + (match.index as number)).reverse();
	for (const arrow of [...arrows, -1]) {
		const text = normalizeAsk(arrow >= 0 ? line.slice(start, arrow) : line.slice(start));
		if (!text) continue;
		const same = asks.filter((ask) => normalizeAsk(ask.text) === text);
		if (!same.length) continue;
		const open = same.filter(isOpen);
		const id = quote[1].toLowerCase();
		const named = open.find((ask) => ask.ordinal.toLowerCase() === id || ask.id === id);
		return { ask: named ?? open.at(-1), arrow };
	}
	return undefined;
}

function isAction(data: unknown): data is AskAction {
	const value = data as Partial<Record<string, unknown>> | undefined;
	if (!value || typeof value.ask !== "string") return false;
	if (value.action === "dismiss" || value.action === "reopen") return true;
	return (value.action === "link" || value.action === "unlink") && typeof value.continues === "string";
}

/**
 * The open asks of a branch, one row per chain, oldest first. Rebuilt in branch order: a later prompt
 * that quotes an ask's text, or cites its ID, answers it, `reply-thread.ask` entries dismiss, reopen, link and unlink, later wins.
 * Answering or dismissing any member of a chain closes the whole chain.
 */
export function buildPending(entries: readonly SessionEntry[], threads = buildThreads(entries)): PendingAsk[] {
	return buildAsks(entries, threads).pending;
}

/**
 * The open asks of a branch as `buildPending` builds them, and the closed ones, one row per chain,
 * oldest first. A closed chain keeps how its first member closed: the first prompt that cited it, or
 * the dismiss.
 */
export function buildAsks(entries: readonly SessionEntry[], threads = buildThreads(entries)): AskState {
	const replies = new Map<string, { reply: Reply; thread: Thread }>();
	const prompts = new Map<string, Thread>();
	for (const thread of threads) {
		if (thread.entryId) prompts.set(thread.entryId, thread);
		for (const reply of thread.replies) replies.set(reply.entryId, { reply, thread });
	}

	const asks = new Map<string, Ask>();
	/** How each closed ask closed, and when, in branch order. */
	const closed = new Map<string, { by: ClosedBy; at: number }>();
	/** The older ask each ask continues. */
	const continues = new Map<string, string>();

	for (const [at, entry] of entries.entries()) {
		const found = replies.get(entry.id);
		if (found) {
			for (const id of questionIds(found.reply)) asks.set(id.id, { ...id, ...found, seq: asks.size });
			continue;
		}
		const thread = prompts.get(entry.id);
		if (thread) {
			const prompt = thread.promptText;
			const lines = prompt.split("\n").map((line) => line.trim());
			// A quote closes the ask whose text it carries, even when its ID now names another ask; the
			// ID rule then skips that line.
			const byText = new Set<number>();
			const known = [...asks.values()];
			for (const [index, line] of lines.entries()) {
				const found = quotedAsk(line, known, (ask) => !closed.has(ask.id));
				if (!found) continue;
				byText.add(index);
				if (found.ask) {
					const text = answerAt(prompt, lines, index, found.arrow);
					closed.set(found.ask.id, { by: { kind: "answer", prompt: thread, text }, at });
				}
			}
			const rest = lines.filter((_, index) => !byText.has(index)).join("\n");
			for (const ask of asks.values()) {
				if (!closed.has(ask.id) && cites(rest, ask)) {
					closed.set(ask.id, { by: { kind: "answer", prompt: thread, text: answerOf(prompt, ask, byText) }, at });
				}
			}
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== ASK_ENTRY || !isAction(entry.data)) continue;
		const action = entry.data;
		const ask = asks.get(action.ask);
		if (!ask) continue;
		if (action.action === "dismiss") {
			if (!closed.has(ask.id)) closed.set(ask.id, { by: { kind: "dismiss" }, at });
		} else if (action.action === "reopen") closed.delete(ask.id);
		else if (action.action === "unlink") {
			if (continues.get(ask.id) === action.continues) continues.delete(ask.id);
		} else if (action.action === "link") {
			const older = asks.get(action.continues);
			if (older && older.seq < ask.seq) continues.set(ask.id, older.id);
		}
	}

	// Chains are the connected groups of links; each gets the ID of its oldest member.
	const root = (id: string): string => {
		let current = id;
		for (let next = continues.get(current); next; next = continues.get(current)) current = next;
		return current;
	};
	const chains = new Map<string, Ask[]>();
	for (const ask of asks.values()) {
		const key = root(ask.id);
		chains.set(key, [...(chains.get(key) ?? []), ask]);
	}

	const rows: PendingAsk[] = [];
	const done: ClosedAsk[] = [];
	for (const members of chains.values()) {
		const newest = members.at(-1) as Ask;
		const closings = members.flatMap((member) => closed.get(member.id) ?? []).sort((a, b) => a.at - b.at);
		if (closings.length) done.push({ ask: newest, chain: members.slice(0, -1), closedBy: closings[0].by });
		else rows.push({ ...newest, chain: members.slice(0, -1), continues: continues.get(newest.id) });
	}
	rows.sort((a, b) => a.seq - b.seq);
	done.sort((a, b) => a.ask.seq - b.ask.seq);

	const openAsks = rows.flatMap((row) => [...row.chain, row]).sort((a, b) => a.seq - b.seq);
	for (const row of rows) {
		if (row.chain.length) continue;
		row.suggestion = openAsks.findLast((other) => other.seq < row.seq && similarAsks(other.text, row.text));
	}
	return { pending: rows, closed: done };
}

/**
 * The open rows as repeat groups: the connected groups of `similarAsks` among the rows, a chain row by
 * its newest text. Each group is oldest first, the groups ordered by their newest row; a row with no
 * repeat is a group of one. Grouping links and closes nothing.
 */
export function similarGroups(pending: readonly PendingAsk[]): PendingAsk[][] {
	const parent = pending.map((_, index) => index);
	const find = (index: number): number => {
		while (parent[index] !== index) index = parent[index];
		return index;
	};
	for (const [left, one] of pending.entries()) {
		for (let right = left + 1; right < pending.length; right += 1) {
			if (similarAsks(one.text, pending[right].text)) parent[find(right)] = find(left);
		}
	}
	const groups = new Map<number, PendingAsk[]>();
	for (const [index, row] of pending.entries()) {
		const key = find(index);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const newest = (group: PendingAsk[]) => Math.max(...group.map((row) => row.seq));
	return [...groups.values()]
		.map((group) => group.sort((a, b) => a.seq - b.seq))
		.sort((a, b) => newest(a) - newest(b));
}

/**
 * The links that make a group one chain: each row's oldest ask continues the group's oldest ask (the
 * root), star-shaped. A lone ask continues itself, and a chain keeps its own links.
 */
export function groupLinks(group: readonly PendingAsk[]): AskAction[] {
	const starts = group.map((row) => row.chain[0] ?? row);
	const root = starts.reduce((oldest, ask) => (ask.seq < oldest.seq ? ask : oldest), starts[0]);
	return starts
		.filter((ask) => ask.id !== root.id)
		.sort((a, b) => a.seq - b.seq)
		.map((ask) => ({ action: "link", ask: ask.id, continues: root.id }));
}
