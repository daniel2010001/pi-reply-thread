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

/** Widget lines for the latest thread, or undefined while it has fewer than 2 replies. */
export function widgetLines(threads: readonly Thread[]): string[] | undefined {
	const thread = threads.at(-1);
	if (!thread || thread.replies.length < 2) return undefined;
	const summary = thread.replies
		.map((reply) => `R${reply.index} ${triggerText(reply.triggers)}${reply.openAsks.length ? " ⚠" : ""}`)
		.join(" · ");
	const lines = [`P${thread.prompt} · ${thread.replies.length} replies: ${summary} · /replies`];
	for (const reply of thread.replies) {
		if (reply.openAsks.length) lines.push(`⚠ ${reply.ordinal} waits on you: ${reply.openAsks[0]}`);
	}
	return lines;
}
