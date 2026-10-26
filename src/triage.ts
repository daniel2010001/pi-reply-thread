import { type Ask, type AskState, type Proposal, proposalKey } from "./pending.ts";
import type { Thread } from "./threads.ts";

/** Longest prompt text sent to the model; a longer one is cut and ends with `…`. */
const PROMPT_LIMIT = 2000;

/** Leads the user message; the session's own system prompt goes unchanged, since some providers accept only that one. */
const INSTRUCTIONS = `You review the open questions an AI assistant asked a user, and the user's later prompts.
Propose only what the text clearly shows:
- "answered": a later prompt answers an open question without quoting it. Give the question ID, the
  prompt ID (P#) and "quote", an exact excerpt of that prompt that is the answer.
- "same": two open questions ask the same thing in other words.
Never invent IDs. When unsure, leave it out. An empty list is a fine answer.
Reply with this JSON object and nothing else:
{"proposals":[{"kind":"answered","ask":"P3.R1.Q1","prompt":"P4","quote":"..."},{"kind":"same","ask":"P5.R2.Q2","as":"P2.R1.Q3"}]}`;

/** What `/replies triage` sends: the instructions, the open asks and later prompts, and their counts. */
export interface TriageRequest {
	instructions: string;
	text: string;
	asks: number;
	prompts: number;
}

/** Every open ask, chain members too, oldest first. */
function openAsks(state: AskState): Ask[] {
	return state.pending.flatMap((row) => [...row.chain, row]).sort((a, b) => a.seq - b.seq);
}

function cut(text: string): string {
	return text.length > PROMPT_LIMIT ? `${text.slice(0, PROMPT_LIMIT)}…` : text;
}

/**
 * The model request for the open asks of a branch: each ask by ordered ID and text, and each prompt
 * after the oldest open ask's prompt by `P#`. Undefined when no ask is open.
 */
export function triageRequest(state: AskState, threads: readonly Thread[]): TriageRequest | undefined {
	const asks = openAsks(state);
	if (!asks.length) return undefined;
	const after = Math.min(...asks.map((ask) => ask.thread.prompt));
	const later = threads.filter((thread) => thread.entryId && thread.prompt > after);
	const prompts = later.length ? later.flatMap((thread) => [`--- P${thread.prompt} ---`, cut(thread.promptText)]) : ["(none)"];
	const text = ["Open questions:", ...asks.map((ask) => `${ask.ordinal}: ${ask.text}`), "", "Later user prompts:", ...prompts].join("\n");
	return { instructions: INSTRUCTIONS, text, asks: asks.length, prompts: later.length };
}

/** The JSON object of a reply: the whole reply, or from its first `{` to its last `}`. */
function readJson(reply: string): unknown {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	try {
		return JSON.parse(reply.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The proposals of a model reply that hold up on the branch, by unique IDs, in reply order, one copy
 * each. Dropped: unknown kinds or IDs, closed asks, an `answered` whose prompt is not after the ask or
 * does not contain the quote (case and runs of spaces aside), a `same` for one ask or two of one chain.
 * A `same` names the newer ask first.
 */
export function parseTriage(reply: string, state: AskState, threads: readonly Thread[]): Proposal[] {
	const json = readJson(reply) as { proposals?: unknown } | undefined;
	if (!json || !Array.isArray(json.proposals)) return [];
	const open = new Map(openAsks(state).map((ask) => [ask.ordinal.toLowerCase(), ask]));
	const rowOf = new Map(state.pending.flatMap((row) => [...row.chain, row].map((member) => [member.id, row] as const)));
	const prompts = new Map(threads.filter((thread) => thread.entryId).map((thread) => [`p${thread.prompt}`, thread]));
	const ask = (id: unknown) => (typeof id === "string" ? open.get(id.toLowerCase()) : undefined);

	const found: Proposal[] = [];
	const seen = new Set<string>();
	for (const item of json.proposals as Partial<Record<string, unknown>>[]) {
		if (!item || typeof item !== "object") continue;
		let proposal: Proposal | undefined;
		if (item.kind === "answered") {
			const asked = ask(item.ask);
			const prompt = typeof item.prompt === "string" ? prompts.get(item.prompt.toLowerCase()) : undefined;
			const quote = typeof item.quote === "string" ? squash(item.quote) : "";
			const holds = quote && prompt && asked && prompt.prompt > asked.thread.prompt;
			if (holds && squash(prompt.promptText).toLowerCase().includes(quote.toLowerCase())) {
				proposal = { kind: "answered", ask: asked.id, prompt: prompt.entryId as string, quote };
			}
		} else if (item.kind === "same") {
			const [one, two] = [ask(item.ask), ask(item.as)];
			if (one && two && rowOf.get(one.id) !== rowOf.get(two.id)) {
				const [newer, older] = one.seq > two.seq ? [one, two] : [two, one];
				proposal = { kind: "same", ask: newer.id, as: older.id };
			}
		}
		if (!proposal) continue;
		const key = `${proposal.ask} ${proposalKey(proposal)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		found.push(proposal);
	}
	return found;
}
