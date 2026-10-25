process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import {
	formatIndex,
	formatReplyPlain,
	formatTime,
	indexRows,
	replyHeader,
	replyRow,
	threadRow,
	triggerText,
	widgetLines,
} from "../src/format.ts";
import type { Reply, Thread, Trigger } from "../src/threads.ts";

function reply(
	prompt: number,
	index: number,
	entryId: string,
	triggers: Trigger[],
	openAsks: string[] = [],
	time = "12:05",
): Reply {
	return {
		ordinal: `P${prompt}.R${index}`,
		index,
		entryId,
		timestamp: `2026-10-25T${time}:00.000Z`,
		text: `Reply ${index} of prompt ${prompt}.`,
		triggers,
		openAsks,
	};
}

const PROMPT: Trigger = { kind: "prompt", label: "prompt" };

const p12: Thread = {
	prompt: 12,
	entryId: "0000000c",
	timestamp: "2026-10-25T12:04:00.000Z",
	promptText: "buscá si existe…\nsegunda línea",
	replies: [
		reply(12, 1, "a1b2c3d4", [PROMPT], ["¿Cuál preferís?", "¿Seguimos?"]),
		reply(12, 2, "e5f6a7b8", [{ kind: "job", label: "tests" }]),
		reply(12, 3, "c9d0e1f2", [{ kind: "worker", label: "docs" }]),
	],
};

const p11: Thread = {
	prompt: 11,
	entryId: "0000000b",
	timestamp: "2026-10-25T11:58:00.000Z",
	promptText: "\n  hola  \n",
	replies: [reply(11, 1, "11111111", [PROMPT], [], "11:59")],
};

describe("triggerText", () => {
	it("labels each trigger kind", () => {
		expect(triggerText([PROMPT])).toBe("prompt");
		expect(triggerText([{ kind: "job", label: "tests" }])).toBe("job: tests");
		expect(triggerText([{ kind: "worker", label: "docs" }])).toBe("worker: docs");
		expect(triggerText([{ kind: "monitor", label: "ci" }])).toBe("monitor: ci");
		expect(triggerText([{ kind: "session", label: "7d8527e5" }])).toBe("session: 7d8527e5");
		expect(triggerText([{ kind: "other", label: "gentle-pi.review-preflight" }])).toBe(
			"other: gentle-pi.review-preflight",
		);
	});

	it("joins several triggers with a comma", () => {
		expect(
			triggerText([
				{ kind: "job", label: "tests" },
				{ kind: "worker", label: "docs" },
			]),
		).toBe("job: tests, worker: docs");
	});

	it("shows follow-up for a reply with no triggers", () => {
		expect(triggerText([])).toBe("follow-up");
	});
});

describe("rows", () => {
	it("formats the time as HH:MM", () => {
		expect(formatTime("2026-10-25T09:07:30.000Z")).toBe("09:07");
	});

	it("formats a thread row with the first prompt line", () => {
		expect(threadRow(p12)).toBe("P12 · 12:04 · buscá si existe…");
		expect(threadRow(p11)).toBe("P11 · 11:58 · hola");
	});

	it("formats replies before the first prompt", () => {
		const p0: Thread = { prompt: 0, timestamp: "2026-10-25T10:00:00.000Z", promptText: "", replies: [] };
		expect(threadRow(p0)).toBe("P0 · 10:00 · (before the first prompt)");
	});

	it("formats reply rows with ordinal, entry ID, triggers and ⚠ for open asks", () => {
		expect(p12.replies.map(replyRow)).toEqual([
			"P12.R1  a1b2c3d4  prompt  ⚠",
			"P12.R2  e5f6a7b8  job: tests",
			"P12.R3  c9d0e1f2  worker: docs",
		]);
		expect(replyRow(reply(12, 4, "deadbeef", []))).toBe("P12.R4  deadbeef  follow-up");
	});

	it("lists threads newest first, each followed by its replies", () => {
		expect(indexRows([p11, p12]).map((row) => [row.text, row.reply?.ordinal])).toEqual([
			["P12 · 12:04 · buscá si existe…", undefined],
			["P12.R1  a1b2c3d4  prompt  ⚠", "P12.R1"],
			["P12.R2  e5f6a7b8  job: tests", "P12.R2"],
			["P12.R3  c9d0e1f2  worker: docs", "P12.R3"],
			["P11 · 11:58 · hola", undefined],
			["P11.R1  11111111  prompt", "P11.R1"],
		]);
	});

	it("renders the plain-text index with indented reply rows", () => {
		expect(formatIndex([p11, p12])).toBe(
			[
				"P12 · 12:04 · buscá si existe…",
				"  P12.R1  a1b2c3d4  prompt  ⚠",
				"  P12.R2  e5f6a7b8  job: tests",
				"  P12.R3  c9d0e1f2  worker: docs",
				"P11 · 11:58 · hola",
				"  P11.R1  11111111  prompt",
			].join("\n"),
		);
		expect(formatIndex([])).toBe("No replies on this branch yet.");
	});

	it("formats the viewer header and the plain-text reply", () => {
		expect(replyHeader(p12.replies[1])).toBe("P12.R2 · e5f6a7b8 · 12:05 · job: tests");
		expect(formatReplyPlain(p12.replies[1])).toBe(
			"P12.R2 · e5f6a7b8 · 12:05 · job: tests\n\nReply 2 of prompt 12.",
		);
	});
});

describe("widgetLines", () => {
	it("summarizes the latest thread and names each reply still waiting", () => {
		const waiting: Thread = {
			...p12,
			replies: [p12.replies[0], { ...p12.replies[1], openAsks: ["Needs your decision: merge?"] }, p12.replies[2]],
		};
		expect(widgetLines([p11, waiting])).toEqual([
			"P12 · 3 replies: R1 prompt ⚠ · R2 job: tests ⚠ · R3 worker: docs · /replies",
			"⚠ P12.R1 waits on you: ¿Cuál preferís?",
			"⚠ P12.R2 waits on you: Needs your decision: merge?",
		]);
	});

	it("has only the summary line when nothing waits", () => {
		const twoReplies: Thread = {
			...p11,
			replies: [p11.replies[0], reply(11, 2, "22222222", [])],
		};
		expect(widgetLines([p12, twoReplies])).toEqual(["P11 · 2 replies: R1 prompt · R2 follow-up · /replies"]);
	});

	it("is hidden while the latest thread has fewer than 2 replies", () => {
		expect(widgetLines([p12, p11])).toBeUndefined();
		expect(widgetLines([p12, { ...p11, replies: [] }])).toBeUndefined();
		expect(widgetLines([])).toBeUndefined();
	});
});
