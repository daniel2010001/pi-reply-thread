import type { SessionEntry } from "@earendil-works/pi-coding-agent";

let counter = 0;
let clock = Date.parse("2026-10-25T12:00:00.000Z");

function base(id?: string) {
	counter += 1;
	clock += 1000;
	return {
		id: id ?? counter.toString(16).padStart(8, "0"),
		parentId: null,
		timestamp: new Date(clock).toISOString(),
	};
}

export function resetIds(): void {
	counter = 0;
	clock = Date.parse("2026-10-25T12:00:00.000Z");
}

export function user(text: string, id?: string): SessionEntry {
	return {
		...base(id),
		type: "message",
		message: { role: "user", content: [{ type: "text", text }], timestamp: clock },
	} as SessionEntry;
}

export function assistant(
	text: string,
	options: { id?: string; stopReason?: string; toolCall?: boolean } = {},
): SessionEntry {
	const content: unknown[] = [];
	if (text) content.push({ type: "text", text });
	if (options.toolCall) content.push({ type: "toolCall", id: "call-1", name: "bash", arguments: {} });
	return {
		...base(options.id),
		type: "message",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {},
			stopReason: options.stopReason ?? (options.toolCall ? "toolUse" : "stop"),
			timestamp: clock,
		},
	} as SessionEntry;
}

export function toolResult(text: string): SessionEntry {
	return {
		...base(),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: clock,
		},
	} as SessionEntry;
}

export function custom(
	customType: string,
	content: string | { type: "text"; text: string }[],
	display = true,
): SessionEntry {
	return { ...base(), type: "custom_message", customType, content, display } as SessionEntry;
}

export function jobNotice(job: string, label: string): SessionEntry {
	return custom(
		"gentle-jobs.notice",
		`Background job ${job} ("${label}") exited with code 0 after 2m 17s.\nCommand: true\nLast output:\nok`,
	);
}

export function workerResult(agent: string, task: string, label: string): SessionEntry {
	return custom(
		"gentle-agents.result",
		`Subagent ${agent} (task ${task}, "${label}") finished.\n\nstatus: completed\n\nsummary: done`,
	);
}

export function sessionMessage(session: string): SessionEntry {
	return custom(
		"gentle-agents.orchestrator-message",
		`Session message from ${session} (correlation 7d8527e58d73c03ea8275648cee9aefa): Recibido.`,
	);
}

const WAKE_TEXT =
	"[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue.";

/** The user-role message gentle-agents sends to wake the session after a job or subagent ends. */
export function wake(nonce?: string): SessionEntry[] {
	const text = nonce ? `${WAKE_TEXT} [gentle-agents wake: ${nonce}]` : WAKE_TEXT;
	const message = user(text);
	if (!nonce) return [message];
	const identity = {
		...base(),
		type: "custom",
		customType: "gentle-agents.wake-identity",
		data: { sessionId: "01a174f0-9039-70c4-a62a-811494db3277", nonce, text },
	} as SessionEntry;
	return [identity, message];
}
