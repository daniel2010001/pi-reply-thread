import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { demoEntries } from "../scripts/demo-session.ts";
import { buildPending } from "../src/pending.ts";

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
			["P1.R1.Q1", "Las mediciones dejaron archivos en `/tmp`: ¿los borro?", undefined],
			["P2.R1.Q1", "Push de los 2 commits de lab-ai a origin/main: ¿lo hago?", undefined],
			["P2.R2.Q1", "Push de los 2 commits nuevos de lab-ai a origin/main: ¿lo hago?", "P2.R1.Q1"],
			["P3.R1.Q1", "¿Borro los archivos temporales de las mediciones en /tmp?", "P1.R1.Q1"],
			["P3.R1.Q2", "¿Sumo la GPU al panel?", undefined],
		]);
	});
});
