import { beforeEach, describe, expect, it } from "vitest";
import { buildAsks } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { parseTriage, triageRequest } from "../src/triage.ts";
import { askEntry, assistant, resetIds, user } from "./helpers.ts";

beforeEach(() => resetIds());

/** P1 asks two things, P2 answers the first without quoting it, P2.R1 asks again, P3 answers the second. */
const session = () => [
	user("hola", "bbbbbbb0"),
	assistant("¿Arrancamos con T14?\n\n¿Usamos Piper?", { id: "aaaaaaa1" }),
	user("vamos con T14, dale", "bbbbbbb1"),
	assistant("¿Empezamos con el núcleo?", { id: "aaaaaaa2" }),
	user("y Piper me   parece bien", "bbbbbbb2"),
];

function request(entries: ReturnType<typeof session>) {
	const threads = buildThreads(entries);
	return triageRequest(buildAsks(entries, threads), threads);
}

function parse(entries: ReturnType<typeof session>, reply: string) {
	const threads = buildThreads(entries);
	return parseTriage(reply, buildAsks(entries, threads), threads);
}

const json = (proposals: unknown[]) => JSON.stringify({ proposals });

describe("triageRequest", () => {
	it("is undefined when no ask is open", () => {
		expect(request([user("hola"), assistant("Listo.")])).toBeUndefined();
		expect(request([...session().slice(0, 2), askEntry({ action: "dismiss", ask: "aaaaaaa1.1" }), askEntry({ action: "dismiss", ask: "aaaaaaa1.2" })])).toBeUndefined();
	});

	it("sends every open ask by ordered ID and every prompt after the oldest open ask's prompt", () => {
		const sent = request(session());
		expect(sent?.text).toBe(
			[
				"Open questions:",
				"P1.R1.Q1: ¿Arrancamos con T14?",
				"P1.R1.Q2: ¿Usamos Piper?",
				"P2.R1.Q1: ¿Empezamos con el núcleo?",
				"",
				"Later user prompts:",
				"--- P2 ---",
				"vamos con T14, dale",
				"--- P3 ---",
				"y Piper me   parece bien",
			].join("\n"),
		);
		expect(sent).toMatchObject({ asks: 3, prompts: 2, chars: sent?.text.length });
		expect(sent?.systemPrompt).toContain('{"proposals":[');
	});

	it("leaves out closed asks and the prompts before the oldest open one", () => {
		const sent = request([...session(), askEntry({ action: "dismiss", ask: "aaaaaaa1.1" }), askEntry({ action: "dismiss", ask: "aaaaaaa1.2" })]);
		expect(sent?.text).toBe(
			["Open questions:", "P2.R1.Q1: ¿Empezamos con el núcleo?", "", "Later user prompts:", "--- P3 ---", "y Piper me   parece bien"].join("\n"),
		);
		expect(sent).toMatchObject({ asks: 1, prompts: 1 });
	});

	it("sends an open ask with no later prompt and says so", () => {
		const sent = request(session().slice(0, 2));
		expect(sent?.text).toBe(["Open questions:", "P1.R1.Q1: ¿Arrancamos con T14?", "P1.R1.Q2: ¿Usamos Piper?", "", "Later user prompts:", "(none)"].join("\n"));
		expect(sent).toMatchObject({ asks: 2, prompts: 0 });
	});

	it("cuts a prompt longer than 2000 characters and marks the cut", () => {
		const long = "a".repeat(2500);
		const sent = request([...session().slice(0, 2), user(long)]);
		expect(sent?.text.split("\n").at(-1)).toBe(`${"a".repeat(2000)}…`);
	});

	it("sends every member of a chain", () => {
		const entries = [...session(), askEntry({ action: "link", ask: "aaaaaaa2.1", continues: "aaaaaaa1.1" })];
		expect(request(entries)?.text.split("\n").slice(1, 4)).toEqual([
			"P1.R1.Q1: ¿Arrancamos con T14?",
			"P1.R1.Q2: ¿Usamos Piper?",
			"P2.R1.Q1: ¿Empezamos con el núcleo?",
		]);
	});
});

describe("parseTriage", () => {
	it("maps an answered proposal to unique IDs, with the quote trimmed and its spaces collapsed", () => {
		const reply = json([{ kind: "answered", ask: "P1.R1.Q2", prompt: "p3", quote: "  Piper me parece   bien " }]);
		expect(parse(session(), reply)).toEqual([{ kind: "answered", ask: "aaaaaaa1.2", prompt: "bbbbbbb2", quote: "Piper me parece bien" }]);
	});

	it("maps a same proposal with the newer ask first, whichever way the model wrote it", () => {
		const one = json([{ kind: "same", ask: "P2.R1.Q1", as: "P1.R1.Q1" }]);
		const two = json([{ kind: "same", ask: "p1.r1.q1", as: "P2.R1.Q1" }]);
		const expected = [{ kind: "same", ask: "aaaaaaa2.1", as: "aaaaaaa1.1" }];
		expect(parse(session(), one)).toEqual(expected);
		expect(parse(session(), two)).toEqual(expected);
	});

	it("reads the JSON object out of a fenced or wrapped reply", () => {
		const proposal = { kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "vamos con T14" };
		const expected = [{ kind: "answered", ask: "aaaaaaa1.1", prompt: "bbbbbbb1", quote: "vamos con T14" }];
		expect(parse(session(), `\`\`\`json\n${json([proposal])}\n\`\`\``)).toEqual(expected);
		expect(parse(session(), `Here you go: ${json([proposal])} Done.`)).toEqual(expected);
	});

	it("returns no proposals for a reply that is not the JSON object", () => {
		for (const reply of ["", "No proposals.", "{not json}", "[]", '{"proposals":{}}', '{"other":[]}']) {
			expect(parse(session(), reply)).toEqual([]);
		}
	});

	it("drops answered proposals that do not hold up", () => {
		const bad = [
			{ kind: "answered", ask: "P9.R1.Q1", prompt: "P2", quote: "vamos" },
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P9", quote: "vamos" },
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P1", quote: "hola" },
			{ kind: "answered", ask: "P2.R1.Q1", prompt: "P2", quote: "vamos" },
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "vamos con Piper" },
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "   " },
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2" },
			{ kind: "answered", ask: "aaaaaaa1.1", prompt: "bbbbbbb1", quote: "vamos" },
			{ kind: "closed", ask: "P1.R1.Q1", prompt: "P2", quote: "vamos" },
			"P1.R1.Q1",
			null,
		];
		expect(parse(session(), json(bad))).toEqual([]);
	});

	it("matches the quote ignoring case and runs of spaces", () => {
		const reply = json([{ kind: "answered", ask: "P1.R1.Q2", prompt: "P3", quote: "PIPER ME PARECE BIEN" }]);
		expect(parse(session(), reply)).toEqual([{ kind: "answered", ask: "aaaaaaa1.2", prompt: "bbbbbbb2", quote: "PIPER ME PARECE BIEN" }]);
	});

	it("drops a proposal for a closed ask", () => {
		const entries = [...session(), askEntry({ action: "dismiss", ask: "aaaaaaa1.1" })];
		const reply = json([
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "vamos" },
			{ kind: "same", ask: "P2.R1.Q1", as: "P1.R1.Q1" },
		]);
		expect(parse(entries, reply)).toEqual([]);
	});

	it("drops a same proposal for one ask, an unknown ask, or two asks of one chain", () => {
		const reply = json([
			{ kind: "same", ask: "P1.R1.Q1", as: "P1.R1.Q1" },
			{ kind: "same", ask: "P1.R1.Q1", as: "P7.R1.Q1" },
			{ kind: "same", ask: "P2.R1.Q1" },
		]);
		expect(parse(session(), reply)).toEqual([]);
		const linked = [...session(), askEntry({ action: "link", ask: "aaaaaaa2.1", continues: "aaaaaaa1.1" })];
		expect(parse(linked, json([{ kind: "same", ask: "P2.R1.Q1", as: "P1.R1.Q1" }]))).toEqual([]);
	});

	it("keeps one copy of a repeated proposal", () => {
		const reply = json([
			{ kind: "same", ask: "P2.R1.Q1", as: "P1.R1.Q1" },
			{ kind: "same", ask: "P1.R1.Q1", as: "P2.R1.Q1" },
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "vamos" },
			{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "dale" },
		]);
		expect(parse(session(), reply)).toEqual([
			{ kind: "same", ask: "aaaaaaa2.1", as: "aaaaaaa1.1" },
			{ kind: "answered", ask: "aaaaaaa1.1", prompt: "bbbbbbb1", quote: "vamos" },
		]);
	});
});
