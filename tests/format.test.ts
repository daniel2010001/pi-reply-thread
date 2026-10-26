process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	answerFormat,
	answerText,
	FORMAT_ENTRY,
	formatIndex,
	formatPending,
	formatReplyPlain,
	formatTime,
	indexRows,
	replyHeader,
	replyRow,
	threadRow,
	triggerText,
	widgetLines,
} from "../src/format.ts";
import { questionIds } from "../src/pending.ts";
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

	it("marks ⚠ only on replies with an open ask and ✓ on the rest that asked, given the open asks", () => {
		const [r1, r2, r3] = p12.replies;
		const thread: Thread = { ...p12, replies: [r1, { ...r2, openAsks: ["¿Mergeo?", "¿Taggeo?"] }, r3] };
		const open = questionIds(thread.replies[1]).slice(0, 1);
		expect(formatIndex([p11, thread], open).split("\n").slice(1, 4)).toEqual([
			"  P12.R1  a1b2c3d4  prompt  ✓",
			"  P12.R2  e5f6a7b8  job: tests  ⚠",
			"  P12.R3  c9d0e1f2  worker: docs",
		]);
		expect(formatIndex([p11, thread], []).split("\n").slice(1, 3)).toEqual([
			"  P12.R1  a1b2c3d4  prompt  ✓",
			"  P12.R2  e5f6a7b8  job: tests  ✓",
		]);
		const chain = [{ ...questionIds(thread.replies[1])[0], chain: questionIds(r1) }];
		expect(formatIndex([p11, thread], chain).split("\n").slice(1, 3)).toEqual([
			"  P12.R1  a1b2c3d4  prompt  ⚠",
			"  P12.R2  e5f6a7b8  job: tests  ⚠",
		]);
	});

	it("formats the viewer header and the plain-text reply", () => {
		expect(replyHeader(p12.replies[1])).toBe("P12.R2 · e5f6a7b8 · 12:05 · job: tests");
		expect(formatReplyPlain(p12.replies[1])).toBe(
			"P12.R2 · e5f6a7b8 · 12:05 · job: tests\n\nReply 2 of prompt 12.",
		);
	});
});

describe("widgetLines", () => {
	const asks = [
		{ ordinal: "P12.R1.Q1", id: "a1b2c3d4.1", text: "¿Cuál preferís?" },
		{ ordinal: "P12.R1.Q2", id: "a1b2c3d4.2", text: "¿Seguimos?" },
		{ ordinal: "P12.R2.Q1", id: "e5f6a7b8.1", text: "Needs your decision: merge?" },
	];

	it("summarizes the latest thread and replaces the waiting lines with one pending line", () => {
		const waiting: Thread = {
			...p12,
			replies: [p12.replies[0], { ...p12.replies[1], openAsks: ["Needs your decision: merge?"] }, p12.replies[2]],
		};
		expect(widgetLines([p11, waiting], asks)).toEqual([
			"P12 · 3 replies: R1 prompt ⚠ · R2 job: tests ⚠ · R3 worker: docs · alt+r",
			"⚠ 3 pending · newest: P12.R2.Q1 Needs your decision: merge? · alt+r",
		]);
	});

	it("marks ⚠ only on replies with an ask still open, a chain member counting while its chain is open", () => {
		const waiting: Thread = {
			...p12,
			replies: [p12.replies[0], { ...p12.replies[1], openAsks: ["Needs your decision: merge?"] }, p12.replies[2]],
		};
		expect(widgetLines([p11, waiting], asks.slice(2))).toEqual([
			"P12 · 3 replies: R1 prompt · R2 job: tests ⚠ · R3 worker: docs · alt+r",
			"⚠ 1 pending · newest: P12.R2.Q1 Needs your decision: merge? · alt+r",
		]);
		const chained = [{ ...asks[2], chain: [asks[1]] }];
		expect(widgetLines([p11, waiting], chained)?.[0]).toBe(
			"P12 · 3 replies: R1 prompt ⚠ · R2 job: tests ⚠ · R3 worker: docs · alt+r",
		);
		expect(widgetLines([p11, waiting])).toEqual(["P12 · 3 replies: R1 prompt · R2 job: tests · R3 worker: docs · alt+r"]);
	});

	it("shows the pending line alone while the latest thread has fewer than 2 replies", () => {
		expect(widgetLines([p12, p11], asks.slice(0, 1))).toEqual(["⚠ 1 pending · newest: P12.R1.Q1 ¿Cuál preferís? · alt+r"]);
	});

	it("has only the summary line when nothing waits", () => {
		const twoReplies: Thread = {
			...p11,
			replies: [p11.replies[0], reply(11, 2, "22222222", [])],
		};
		expect(widgetLines([p12, twoReplies])).toEqual(["P11 · 2 replies: R1 prompt · R2 follow-up · alt+r"]);
	});

	it("is hidden while the latest thread has fewer than 2 replies", () => {
		expect(widgetLines([p12, p11])).toBeUndefined();
		expect(widgetLines([p12, { ...p11, replies: [] }])).toBeUndefined();
		expect(widgetLines([])).toBeUndefined();
	});
});

describe("formatPending", () => {
	it("lists one open ask per line with its ordered and unique IDs", () => {
		expect(
			formatPending([
				{ ordinal: "P12.R1.Q1", id: "a1b2c3d4.1", text: "¿Cuál preferís?" },
				{ ordinal: "P13.R2.Q3", id: "e5f6a7b8.3", text: "Necesito tu OK." },
			]),
		).toBe("P12.R1.Q1  a1b2c3d4.1  ¿Cuál preferís?\nP13.R2.Q3  e5f6a7b8.3  Necesito tu OK.");
	});

	it("says nothing waits when there are no open asks", () => {
		expect(formatPending([])).toBe("Nothing waits on you.");
	});
});

describe("answerText", () => {
	const asks = [
		{ ordinal: "P13.R1.Q1", id: "a1b2c3d4.1", text: "¿Los borro?" },
		{ ordinal: "P13.R2.Q1", id: "e5f6a7b8.1", text: "¿Pusheo?" },
	];

	it("lines (the default): a quote per ask, an `R: ` line under it, asks apart by an empty line, no trailing newline", () => {
		expect(answerText(asks.slice(0, 1))).toBe("> P13.R1.Q1: ¿Los borro?\nR: ");
		expect(answerText(asks)).toBe("> P13.R1.Q1: ¿Los borro?\nR: \n\n> P13.R2.Q1: ¿Pusheo?\nR: ");
		expect(answerText(asks, false, "lines")).toBe(answerText(asks));
	});

	it("lines with a yes: `R: Yes.` under each quote", () => {
		expect(answerText(asks.slice(0, 1), true)).toBe("> P13.R1.Q1: ¿Los borro?\nR: Yes.");
		expect(answerText(asks, true, "lines")).toBe("> P13.R1.Q1: ¿Los borro?\nR: Yes.\n\n> P13.R2.Q1: ¿Pusheo?\nR: Yes.");
	});

	it("inline: the answer on the quote line after `→ `, one ask per line, no trailing newline", () => {
		expect(answerText(asks.slice(0, 1), false, "inline")).toBe("> P13.R1.Q1: ¿Los borro? → ");
		expect(answerText(asks, false, "inline")).toBe("> P13.R1.Q1: ¿Los borro? → \n> P13.R2.Q1: ¿Pusheo? → ");
	});

	it("inline with a yes: `→ Yes.` on each quote line", () => {
		expect(answerText(asks.slice(0, 1), true, "inline")).toBe("> P13.R1.Q1: ¿Los borro? → Yes.");
		expect(answerText(asks, true, "inline")).toBe("> P13.R1.Q1: ¿Los borro? → Yes.\n> P13.R2.Q1: ¿Pusheo? → Yes.");
	});
});

describe("answerFormat", () => {
	const entry = (data: unknown, customType = FORMAT_ENTRY) =>
		({ type: "custom", id: "f0000001", parentId: null, timestamp: "", customType, data }) as SessionEntry;

	it("defaults to lines and takes the latest reply-thread.format entry on the branch", () => {
		expect(answerFormat([])).toBe("lines");
		expect(answerFormat([entry({ format: "inline" })])).toBe("inline");
		expect(answerFormat([entry({ format: "inline" }), entry({ format: "lines" })])).toBe("lines");
		expect(answerFormat([entry({ format: "lines" }), entry({ format: "inline" })])).toBe("inline");
	});

	it("ignores other entries and unknown formats", () => {
		expect(answerFormat([entry({ format: "inline" }), entry({ format: "table" })])).toBe("inline");
		expect(answerFormat([entry({ format: "inline" }, "reply-thread.ask")])).toBe("lines");
	});
});
