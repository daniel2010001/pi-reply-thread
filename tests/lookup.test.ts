import { describe, expect, it } from "vitest";
import { findReply, noMatchMessage } from "../src/lookup.ts";
import type { Reply, Thread } from "../src/threads.ts";

function reply(prompt: number, index: number, entryId: string): Reply {
	return {
		ordinal: `P${prompt}.R${index}`,
		index,
		entryId,
		timestamp: "2026-10-25T12:04:00.000Z",
		text: `reply ${prompt}.${index}`,
		triggers: [],
		openAsks: [],
	};
}

const threads: Thread[] = [
	{
		prompt: 1,
		entryId: "00000001",
		timestamp: "2026-10-25T12:00:00.000Z",
		promptText: "first",
		replies: [reply(1, 1, "a1b2c3d4"), reply(1, 2, "e5f6a7b8")],
	},
	{
		prompt: 12,
		entryId: "00000012",
		timestamp: "2026-10-25T12:04:00.000Z",
		promptText: "twelfth",
		replies: [reply(12, 1, "c9d0e1f2")],
	},
];

describe("findReply", () => {
	it("finds a reply by its ordered ID", () => {
		expect(findReply(threads, "P1.R2")?.entryId).toBe("e5f6a7b8");
		expect(findReply(threads, "P12.R1")?.entryId).toBe("c9d0e1f2");
	});

	it("matches the ordered ID case-insensitively", () => {
		expect(findReply(threads, "p12.r1")?.entryId).toBe("c9d0e1f2");
		expect(findReply(threads, "p1.R2")?.entryId).toBe("e5f6a7b8");
	});

	it("finds a reply by its exact entry ID", () => {
		expect(findReply(threads, "a1b2c3d4")?.ordinal).toBe("P1.R1");
	});

	it("ignores surrounding whitespace", () => {
		expect(findReply(threads, "  P1.R1 ")?.entryId).toBe("a1b2c3d4");
	});

	it("does not match partial IDs, a different-case entry ID, or a prompt-only ordinal", () => {
		expect(findReply(threads, "a1b2")).toBeUndefined();
		expect(findReply(threads, "A1B2C3D4")).toBeUndefined();
		expect(findReply(threads, "P1")).toBeUndefined();
		expect(findReply(threads, "P1.R3")).toBeUndefined();
		expect(findReply(threads, "P2.R1")).toBeUndefined();
	});
});

describe("noMatchMessage", () => {
	it("names the argument and points to /replies", () => {
		expect(noMatchMessage("P9.R9")).toBe('No reply matches "P9.R9". Run /replies to list them.');
	});
});

describe("findReply by question ID", () => {
	const asking: Thread[] = [
		{
			...threads[1],
			replies: [{ ...reply(12, 1, "c9d0e1f2"), openAsks: ["¿Uno?", "¿Dos?"] }],
		},
	];

	it("opens the reply of a question by its ordered ID, any case, or its unique ID", () => {
		expect(findReply(asking, "P12.R1.Q2")?.entryId).toBe("c9d0e1f2");
		expect(findReply(asking, "p12.r1.q1")?.entryId).toBe("c9d0e1f2");
		expect(findReply(asking, "c9d0e1f2.2")?.ordinal).toBe("P12.R1");
	});

	it("does not match a question the reply does not have", () => {
		expect(findReply(asking, "P12.R1.Q3")).toBeUndefined();
		expect(findReply(asking, "P12.R1.Q0")).toBeUndefined();
		expect(findReply(asking, "c9d0e1f2.3")).toBeUndefined();
		expect(findReply(asking, "C9D0E1F2.1")).toBeUndefined();
	});
});
