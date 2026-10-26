/**
 * Writes a Pi session file with repeated open asks, to try the central without a real session:
 *
 *   node scripts/demo-session.ts [output.jsonl]
 *   pi --session <output.jsonl> -e ./extensions/reply-thread.ts
 *
 * Without an argument the file goes to a new temporary directory. Opening it with Pi appends to it.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface DemoEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

/** Prompt → reply pairs and notices that leave repeats (`≈`), a chain to build with `l`, and a heading. */
const SCRIPT: readonly (["user" | "assistant", string] | ["job", string, string])[] = [
	["user", "Measure the desktop's power draw."],
	["assistant", "Done, 41 W at idle.\n\nThe measurement files are still in `/tmp`: should I delete them?"],
	["user", "Check the lab-ai push."],
	["assistant", "There are 2 new commits in `lab-ai`.\n\nPush the 2 lab-ai commits to origin/main: should I do it?"],
	["job", "job-1", "tests"],
	["assistant", "Tests are green.\n\n## Why did it take so long?\n\nThe first start compiles the modules.\n\nPush the 2 new lab-ai commits to origin/main: should I do it?"],
	["user", "Let's continue with the panel."],
	["assistant", "The panel shows the CPU now.\n\n- Should I delete the measurement files still in /tmp?\n- Should I add the GPU to the panel?"],
];

/** Pi's footer adds up every reply's usage, cost included, so a demo reply needs all of it. */
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function demoEntries(cwd: string, start = Date.parse("2026-10-25T12:00:00.000Z")): DemoEntry[] {
	let clock = start;
	let parentId: string | null = null;
	const entries: DemoEntry[] = [];
	const next = (fields: Record<string, unknown>): void => {
		clock += 60_000;
		const id = (entries.length + 1).toString(16).padStart(8, "0");
		entries.push({ ...fields, type: fields.type as string, id, parentId, timestamp: new Date(clock).toISOString() });
		parentId = id;
	};
	for (const step of SCRIPT) {
		if (step[0] === "job") {
			const [, job, label] = step;
			next({
				type: "custom_message",
				customType: "gentle-jobs.notice",
				content: `Background job ${job} ("${label}") exited with code 0 after 12s.`,
				display: true,
			});
			continue;
		}
		const [role, text] = step;
		const message =
			role === "user"
				? { role, content: [{ type: "text", text }], timestamp: clock }
				: {
						role,
						content: [{ type: "text", text }],
						api: "anthropic-messages",
						provider: "demo",
						model: "demo",
						usage: EMPTY_USAGE,
						stopReason: "stop",
						timestamp: clock,
					};
		next({ type: "message", message });
	}
	const header = {
		type: "session",
		version: 3,
		id: "01a1d300-0000-7000-8000-000000000000",
		timestamp: new Date(start).toISOString(),
		cwd,
	};
	return [header as unknown as DemoEntry, ...entries];
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const output = resolve(process.argv[2] ?? join(mkdtempSync(join(tmpdir(), "reply-thread-demo-")), "demo.jsonl"));
	writeFileSync(output, `${demoEntries(process.cwd()).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	console.log(`Wrote ${output}\nTry it: pi --session ${output} -e ./extensions/reply-thread.ts`);
}
