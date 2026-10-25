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

export function questionIds(reply: Reply): QuestionId[] {
	return reply.openAsks.map((text, index) => ({
		ordinal: `${reply.ordinal}.Q${index + 1}`,
		id: `${reply.entryId}.${index + 1}`,
		text,
	}));
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

function isAction(data: unknown): data is AskAction {
	const value = data as Partial<Record<string, unknown>> | undefined;
	if (!value || typeof value.ask !== "string") return false;
	if (value.action === "dismiss" || value.action === "reopen") return true;
	return (value.action === "link" || value.action === "unlink") && typeof value.continues === "string";
}

/**
 * The open asks of a branch, one row per chain, oldest first. Rebuilt in branch order: a later prompt
 * that cites an ask answers it, `reply-thread.ask` entries dismiss, reopen, link and unlink, later wins.
 * Answering or dismissing any member of a chain closes the whole chain.
 */
export function buildPending(entries: readonly SessionEntry[], threads = buildThreads(entries)): PendingAsk[] {
	const replies = new Map<string, { reply: Reply; thread: Thread }>();
	const prompts = new Map<string, Thread>();
	for (const thread of threads) {
		if (thread.entryId) prompts.set(thread.entryId, thread);
		for (const reply of thread.replies) replies.set(reply.entryId, { reply, thread });
	}

	const asks = new Map<string, Ask>();
	const closed = new Set<string>();
	/** The older ask each ask continues. */
	const continues = new Map<string, string>();

	for (const entry of entries) {
		const found = replies.get(entry.id);
		if (found) {
			for (const id of questionIds(found.reply)) asks.set(id.id, { ...id, ...found, seq: asks.size });
			continue;
		}
		const thread = prompts.get(entry.id);
		if (thread) {
			for (const ask of asks.values()) if (cites(thread.promptText, ask)) closed.add(ask.id);
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== ASK_ENTRY || !isAction(entry.data)) continue;
		const action = entry.data;
		const ask = asks.get(action.ask);
		if (!ask) continue;
		if (action.action === "dismiss") closed.add(ask.id);
		else if (action.action === "reopen") closed.delete(ask.id);
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
	for (const members of chains.values()) {
		if (members.some((member) => closed.has(member.id))) continue;
		const newest = members.at(-1) as Ask;
		rows.push({ ...newest, chain: members.slice(0, -1), continues: continues.get(newest.id) });
	}
	rows.sort((a, b) => a.seq - b.seq);

	const openAsks = rows.flatMap((row) => [...row.chain, row]).sort((a, b) => a.seq - b.seq);
	for (const row of rows) {
		if (row.chain.length) continue;
		row.suggestion = openAsks.findLast((other) => other.seq < row.seq && similarAsks(other.text, row.text));
	}
	return rows;
}
