import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { detectOpenAsks } from "./asks.ts";

export type TriggerKind = "prompt" | "job" | "monitor" | "worker" | "session" | "other";

/** What made the agent produce a reply: the prompt itself or a message that arrived after it. */
export interface Trigger {
	kind: TriggerKind;
	label: string;
}

export interface Reply {
	/** Ordered ID, `P<prompt>.R<reply>`, stable for a given session branch. */
	ordinal: string;
	/** Position of the reply under its prompt, starting at 1. */
	index: number;
	/** Unique ID: the Pi session entry ID of the assistant message. */
	entryId: string;
	timestamp: string;
	text: string;
	/** Everything that arrived since the previous reply. Empty for a plain follow-up. */
	triggers: Trigger[];
	/** Lines of this reply that wait on the user (questions, decisions); empty when none. */
	openAsks: string[];
}

export interface Thread {
	/** Prompt number on the branch, starting at 1; 0 holds replies that came before any prompt. */
	prompt: number;
	/** Entry ID of the user prompt, absent for thread 0. */
	entryId?: string;
	timestamp: string;
	promptText: string;
	replies: Reply[];
}

/** Stop reasons of an assistant message that finished speaking instead of calling tools or failing. */
const FINISHED = new Set(["stop", "length"]);

const PROMPT_TRIGGER: Trigger = { kind: "prompt", label: "prompt" };

type Content = string | readonly { type: string; text?: string }[] | undefined;

function textOf(content: Content): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * gentle-agents wakes the session with a user-role message after a job or subagent ends. It is not a
 * prompt: the notice that came before it is the trigger of the next reply.
 */
const WAKE_PREFIX = "[System-generated Gentle Agents notification, not written by the user]";

const JOB = /^Background job (\S+)(?: \("((?:[^"\\]|\\.)*)"\))?/;
const MONITOR = /^Monitor (\S+)(?: \("((?:[^"\\]|\\.)*)"\))?/;
const WORKER = /^Subagent (\S+) \(task [^,)]+(?:, "((?:[^"\\]|\\.)*)")?\) finished/;
const SESSION = /^Session message from ([0-9A-Za-z_-]+)/;

/** Turns a visible custom message into the trigger it stands for. */
export function triggerOf(customType: string, content: Content): Trigger {
	const text = textOf(content).trimStart();
	if (customType === "gentle-jobs.notice") {
		const match = JOB.exec(text);
		if (match) return { kind: "job", label: match[2] || match[1] };
		const monitor = MONITOR.exec(text);
		if (monitor) return { kind: "monitor", label: monitor[2] || monitor[1] };
	}
	if (customType === "gentle-agents.result") {
		const match = WORKER.exec(text);
		if (match) return { kind: "worker", label: match[2] || match[1] };
	}
	if (customType === "gentle-agents.orchestrator-message") {
		const match = SESSION.exec(text);
		if (match) return { kind: "session", label: match[1].slice(0, 8) };
	}
	return { kind: "other", label: customType };
}

/**
 * Groups the final assistant replies of a session branch under the prompt that preceded them.
 * Pass `ctx.sessionManager.getBranch()`: abandoned branches are alternative histories.
 */
export function buildThreads(entries: readonly SessionEntry[]): Thread[] {
	const threads: Thread[] = [];
	let current: Thread | undefined;
	let pending: Trigger[] = [];
	let prompts = 0;

	for (const entry of entries) {
		if (entry.type === "custom_message") {
			if (entry.display) pending.push(triggerOf(entry.customType, entry.content));
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: Content; stopReason?: string };

		if (message.role === "user") {
			if (textOf(message.content).startsWith(WAKE_PREFIX)) continue;
			prompts += 1;
			current = {
				prompt: prompts,
				entryId: entry.id,
				timestamp: entry.timestamp,
				promptText: textOf(message.content),
				replies: [],
			};
			threads.push(current);
			pending = [PROMPT_TRIGGER];
			continue;
		}

		if (message.role !== "assistant" || !FINISHED.has(message.stopReason ?? "")) continue;
		const text = textOf(message.content).trim();
		if (!text) continue;

		if (!current) {
			current = { prompt: 0, timestamp: entry.timestamp, promptText: "", replies: [] };
			threads.push(current);
		}
		const index = current.replies.length + 1;
		current.replies.push({
			ordinal: `P${current.prompt}.R${index}`,
			index,
			entryId: entry.id,
			timestamp: entry.timestamp,
			text,
			triggers: pending,
			openAsks: detectOpenAsks(text),
		});
		pending = [];
	}

	return threads;
}
