import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { QuestionId } from "./pending.ts";
import type { Reply, Thread, Trigger } from "./threads.ts";

/** One line of the reply index: a thread header, or a reply that can be opened. */
export interface IndexRow {
	text: string;
	thread: Thread;
	reply?: Reply;
}

export function formatTime(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "--:--";
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function triggerLabel(trigger: Trigger): string {
	return trigger.kind === "prompt" ? "prompt" : `${trigger.kind}: ${trigger.label}`;
}

/** What made a reply, joined with `, `; a reply with no triggers is a `follow-up`. */
export function triggerText(triggers: readonly Trigger[]): string {
	return triggers.length ? triggers.map(triggerLabel).join(", ") : "follow-up";
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

/** The first line of the prompt that started a thread. */
export function promptLine(thread: Thread): string {
	return thread.prompt === 0 ? "(before the first prompt)" : firstLine(thread.promptText);
}

export function threadRow(thread: Thread): string {
	return `P${thread.prompt} · ${formatTime(thread.timestamp)} · ${promptLine(thread)}`;
}

export function replyRow(reply: Reply): string {
	const row = `${reply.ordinal}  ${reply.entryId}  ${triggerText(reply.triggers)}`;
	return reply.openAsks.length ? `${row}  ⚠` : row;
}

/** Threads newest first, each followed by its replies in order. */
export function indexRows(threads: readonly Thread[]): IndexRow[] {
	const rows: IndexRow[] = [];
	for (const thread of [...threads].reverse()) {
		rows.push({ text: threadRow(thread), thread });
		for (const reply of thread.replies) rows.push({ text: replyRow(reply), thread, reply });
	}
	return rows;
}

/** The index as plain text, for modes without the TUI. */
export function formatIndex(threads: readonly Thread[]): string {
	if (!threads.length) return "No replies on this branch yet.";
	return indexRows(threads)
		.map((row) => (row.reply ? `  ${row.text}` : row.text))
		.join("\n");
}

export function replyHeader(reply: Reply): string {
	return `${reply.ordinal} · ${reply.entryId} · ${formatTime(reply.timestamp)} · ${triggerText(reply.triggers)}`;
}

export function formatReplyPlain(reply: Reply): string {
	return `${replyHeader(reply)}\n\n${reply.text}`;
}

/**
 * Widget lines: the latest thread while it has 2 or more replies, and one line for the open asks
 * (oldest first, a chain counted once). Undefined when there is nothing to show.
 */
export function widgetLines(threads: readonly Thread[], pending: readonly QuestionId[] = []): string[] | undefined {
	const lines: string[] = [];
	const thread = threads.at(-1);
	if (thread && thread.replies.length >= 2) {
		const summary = thread.replies
			.map((reply) => `R${reply.index} ${triggerText(reply.triggers)}${reply.openAsks.length ? " ⚠" : ""}`)
			.join(" · ");
		lines.push(`P${thread.prompt} · ${thread.replies.length} replies: ${summary} · alt+r`);
	}
	const newest = pending.at(-1);
	if (newest) lines.push(`⚠ ${pending.length} pending · newest: ${newest.ordinal} ${newest.text} · alt+r`);
	return lines.length ? lines : undefined;
}

/** The open asks as plain text, for modes without the TUI. */
export function formatPending(pending: readonly QuestionId[]): string {
	if (!pending.length) return "Nothing waits on you.";
	return pending.map((ask) => `${ask.ordinal}  ${ask.id}  ${ask.text}`).join("\n");
}

/** Custom entry type of the answer format chosen in the central, written with `pi.appendEntry`. */
export const FORMAT_ENTRY = "reply-thread.format";

/** How the central pastes an answer: an `R: ` line under each quote, or `→ ` on the quote line. */
export type AnswerFormat = "lines" | "inline";

/** The name the Pending hints show for each format. */
export const FORMAT_NAMES: Record<AnswerFormat, string> = { lines: "R: lines", inline: "same line" };

/** The latest format chosen on the branch; `lines` when none was. */
export function answerFormat(entries: readonly SessionEntry[]): AnswerFormat {
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "custom" || entry.customType !== FORMAT_ENTRY) continue;
		const format = (entry.data as { format?: unknown } | undefined)?.format;
		if (format === "lines" || format === "inline") return format;
	}
	return "lines";
}

/**
 * What the central pastes to answer asks: a quote per ask with its ordered ID, so sending it closes
 * the ask, and room for the answer right after it, with no trailing newline so the cursor waits there.
 * `lines` puts `R: ` under each quote and an empty line between asks; `inline` puts `→ ` on the quote
 * line, one ask per line. A yes writes `Sí.` as the answer.
 */
export function answerText(asks: readonly QuestionId[], yes = false, format: AnswerFormat = "lines"): string {
	const answer = yes ? "Sí." : "";
	const quotes = asks.map((ask) => `> ${ask.ordinal}: ${ask.text}`);
	if (format === "inline") return quotes.map((quote) => `${quote} → ${answer}`).join("\n");
	return quotes.map((quote) => `${quote}\nR: ${answer}`).join("\n\n");
}
