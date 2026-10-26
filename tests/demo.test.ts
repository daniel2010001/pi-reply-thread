import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { demoEntries } from "../scripts/demo-session.ts";
import { buildPending, similarGroups } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";

describe("demo session", () => {
	const [header, ...entries] = demoEntries("/work/demo");
	const branch = entries as unknown as SessionEntry[];

	it("starts with a version 3 session header for the given directory", () => {
		expect(header).toMatchObject({ type: "session", version: 3, cwd: "/work/demo" });
		expect(entries.every((entry, index) => entry.parentId === (index ? entries[index - 1].id : null))).toBe(true);
	});

	it("leaves repeated asks that the central suggests linking, and no ask for the heading", () => {
		const pending = buildPending(branch);
		expect(pending.map((ask) => [ask.ordinal, ask.text, ask.suggestion?.ordinal])).toEqual([
			["P1.R1.Q1", "The measurement files are still in `/tmp`: should I delete them?", undefined],
			["P2.R1.Q1", "Push the 2 lab-ai commits to origin/main: should I do it?", undefined],
			["P2.R2.Q1", "Push the 2 new lab-ai commits to origin/main: should I do it?", "P2.R1.Q1"],
			["P3.R1.Q1", "Should I delete the measurement files still in /tmp?", "P1.R1.Q1"],
			["P3.R1.Q2", "Should I add the GPU to the panel?", undefined],
		]);
	});

	it("is in English, with a job notice and two repeat groups in the Pending rows", () => {
		const threads = buildThreads(branch);
		expect(threads.map((thread) => thread.promptText)).toEqual([
			"Measure the desktop's power draw.",
			"Check the lab-ai push.",
			"Let's continue with the panel.",
		]);
		expect(threads[1].replies[1].triggers).toEqual([{ kind: "job", label: "tests" }]);
		expect(threads[1].replies[1].text).toContain("## Why did it take so long?");
		expect(similarGroups(buildPending(branch)).map((group) => group.map((ask) => ask.ordinal))).toEqual([
			["P2.R1.Q1", "P2.R2.Q1"],
			["P1.R1.Q1", "P3.R1.Q1"],
			["P3.R1.Q2"],
		]);
	});

	it("gives every reply the full usage Pi's footer adds up", () => {
		const replies = entries.filter((entry) => (entry.message as { role?: string } | undefined)?.role === "assistant");
		expect(replies).toHaveLength(4);
		for (const entry of replies) {
			expect((entry.message as { usage: unknown }).usage).toEqual({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			});
		}
	});
});

