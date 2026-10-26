import { beforeEach, describe, expect, it } from "vitest";
import { answerText } from "../src/format.ts";
import { buildAsks, buildPending, normalizeAsk, questionIds, similarAsks } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { askEntry, assistant, resetIds, user, wake } from "./helpers.ts";

beforeEach(() => resetIds());

const open = (entries: Parameters<typeof buildPending>[0]) =>
	buildPending(entries).map((ask) => [ask.ordinal, ask.id, ask.text]);

describe("questionIds", () => {
	it("numbers the asks of a reply: P#.R#.Q<n> and <entry ID>.<n>, n from 1", () => {
		const [thread] = buildThreads([user("hola"), assistant("¿Uno?\n\n¿Dos?", { id: "a1b2c3d4" })]);
		expect(questionIds(thread.replies[0])).toEqual([
			{ ordinal: "P1.R1.Q1", id: "a1b2c3d4.1", text: "¿Uno?" },
			{ ordinal: "P1.R1.Q2", id: "a1b2c3d4.2", text: "¿Dos?" },
		]);
		expect(questionIds(buildThreads([user("x"), assistant("Listo.")])[0].replies[0])).toEqual([]);
	});
});

describe("buildPending: answered", () => {
	const base = () => [user("hola"), assistant("¿Uno?\n\n¿Dos?", { id: "a1b2c3d4" })];

	it("lists every open ask in branch order", () => {
		expect(open(base())).toEqual([
			["P1.R1.Q1", "a1b2c3d4.1", "¿Uno?"],
			["P1.R1.Q2", "a1b2c3d4.2", "¿Dos?"],
		]);
	});

	it("closes an ask when a later prompt cites its ordered ID, in any case", () => {
		expect(open([...base(), user("> P1.R1.Q1: ¿Uno?\nSí.")]).map(([id]) => id)).toEqual(["P1.R1.Q2"]);
		expect(open([...base(), user("p1.r1.q2 dale")]).map(([id]) => id)).toEqual(["P1.R1.Q1"]);
	});

	it("closes the asks a prompt pasted in either answer format cites", () => {
		const asks = buildPending(base());
		for (const format of ["lines", "inline"] as const) {
			for (const yes of [false, true]) {
				expect(open([...base(), user(`${answerText(asks, yes, format)}dale`)])).toEqual([]);
				expect(open([...base(), user(answerText(asks.slice(1), yes, format))]).map(([id]) => id)).toEqual(["P1.R1.Q1"]);
			}
		}
	});

	it("closes an ask when a later prompt cites its unique ID", () => {
		expect(open([...base(), user("sobre a1b2c3d4.2: no")]).map(([id]) => id)).toEqual(["P1.R1.Q1"]);
	});

	it("does not close an ask from a gentle-agents wake that contains its ID", () => {
		const entries = [...base(), ...wake("n1")];
		const message = entries.at(-1) as { message: { content: { text: string }[] } };
		message.message.content[0].text += " P1.R1.Q1 a1b2c3d4.2";
		expect(open(entries)).toHaveLength(2);
	});

	it("does not close on a longer ID that only starts with it, nor on the reply ID alone", () => {
		const entries = [...base(), user("P1.R1.Q10, P11.R1.Q1, a1b2c3d4.20, P1.R1 y a1b2c3d4")];
		expect(open(entries)).toHaveLength(2);
	});

	it("does not close an ask from a prompt that came before its reply", () => {
		resetIds();
		const entries = [user("P2.R1.Q1"), assistant("Ok."), user("seguí"), assistant("¿Tres?")];
		expect(open(entries).map(([id]) => id)).toEqual(["P2.R1.Q1"]);
	});
});

describe("buildPending: dismiss and reopen", () => {
	const base = () => [user("hola"), assistant("¿Uno?\n\n¿Dos?", { id: "a1b2c3d4" })];

	it("hides a dismissed ask", () => {
		expect(open([...base(), askEntry({ action: "dismiss", ask: "a1b2c3d4.1" })]).map(([id]) => id)).toEqual([
			"P1.R1.Q2",
		]);
	});

	it("lets the later entry win: reopen after dismiss shows it, dismiss after reopen hides it", () => {
		const dismiss = askEntry({ action: "dismiss", ask: "a1b2c3d4.1" });
		const reopen = askEntry({ action: "reopen", ask: "a1b2c3d4.1" });
		const again = askEntry({ action: "dismiss", ask: "a1b2c3d4.1" });
		expect(open([...base(), dismiss, reopen])).toHaveLength(2);
		expect(open([...base(), dismiss, reopen, again])).toHaveLength(1);
	});

	it("ignores entries for unknown asks and other custom entries", () => {
		const entries = [
			...base(),
			askEntry({ action: "dismiss", ask: "ffffffff.1" }),
			askEntry({ action: "dismiss", ask: "a1b2c3d4.9" }),
			{ ...askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }), customType: "other.ext" },
		] as Parameters<typeof buildPending>[0];
		expect(open(entries)).toHaveLength(2);
	});
});

describe("buildPending: chains", () => {
	const chain = () => [
		user("limpiá"),
		assistant("¿Los borro?", { id: "aaaaaaa1" }),
		user("seguí"),
		assistant("Listo el resto. ¿Los borro?", { id: "aaaaaaa2" }),
		user("y ahora"),
		assistant("Ya está. ¿Los borro todos?", { id: "aaaaaaa3" }),
		askEntry({ action: "link", ask: "aaaaaaa2.1", continues: "aaaaaaa1.1" }),
		askEntry({ action: "link", ask: "aaaaaaa3.1", continues: "aaaaaaa2.1" }),
	];

	it("shows a chain once, on its newest member, with the older members", () => {
		const [row, ...rest] = buildPending(chain());
		expect(rest).toEqual([]);
		expect(row.ordinal).toBe("P3.R1.Q1");
		expect(row.chain.map((ask) => ask.ordinal)).toEqual(["P1.R1.Q1", "P2.R1.Q1"]);
		expect(row.suggestion).toBeUndefined();
	});

	it("closes the whole chain when any member is answered", () => {
		expect(buildPending([...chain(), user("> P1.R1.Q1: ¿Los borro?\nSí.")])).toEqual([]);
		expect(buildPending([...chain(), user("> P3.R1.Q1: ¿Los borro todos?")])).toEqual([]);
	});

	it("closes the whole chain when any member is dismissed", () => {
		expect(buildPending([...chain(), askEntry({ action: "dismiss", ask: "aaaaaaa2.1" })])).toEqual([]);
	});

	it("splits a chain on unlink", () => {
		const rows = buildPending([...chain(), askEntry({ action: "unlink", ask: "aaaaaaa3.1", continues: "aaaaaaa2.1" })]);
		expect(rows.map((ask) => [ask.ordinal, ask.chain.map((member) => member.ordinal)])).toEqual([
			["P2.R1.Q1", ["P1.R1.Q1"]],
			["P3.R1.Q1", []],
		]);
	});

	it("ignores a link from an older ask to a newer one, or to itself", () => {
		const rows = buildPending([
			...chain().slice(0, 4),
			askEntry({ action: "link", ask: "aaaaaaa1.1", continues: "aaaaaaa2.1" }),
			askEntry({ action: "link", ask: "aaaaaaa2.1", continues: "aaaaaaa2.1" }),
		]);
		expect(rows.map((ask) => ask.chain.length)).toEqual([0, 0]);
	});
});

describe("buildPending: repeat suggestions", () => {
	it("suggests the newest older open ask with the same normalized text, never linking it", () => {
		const rows = buildPending([
			user("a"),
			assistant("¿Los borro?", { id: "bbbbbbb1" }),
			user("b"),
			assistant("**¿Los BORRO?**", { id: "bbbbbbb2" }),
			user("c"),
			assistant("los borro?", { id: "bbbbbbb3" }),
		]);
		expect(rows.map((ask) => [ask.ordinal, ask.suggestion?.ordinal, ask.chain.length])).toEqual([
			["P1.R1.Q1", undefined, 0],
			["P2.R1.Q1", "P1.R1.Q1", 0],
			["P3.R1.Q1", "P2.R1.Q1", 0],
		]);
	});

	it("suggests on word overlap of at least 0.6 and not below", () => {
		const rows = buildPending([
			user("a"),
			assistant("¿Pusheo la rama feature ahora?", { id: "ccccccc1" }),
			user("b"),
			// {pusheo, rama, feature, ahora} vs {pusheo, rama, feature, main}: 3/5 = 0.6
			assistant("¿Pusheo la rama feature a main?", { id: "ccccccc2" }),
			user("c"),
			// {pusheo, tags} vs either: 1/5
			assistant("¿Pusheo los tags?", { id: "ccccccc3" }),
		]);
		expect(rows.map((ask) => ask.suggestion?.ordinal)).toEqual([undefined, "P1.R1.Q1", undefined]);
		// Only words longer than 3 letters count: {tres, cuatro, cinco} vs {tres, cuatro, seis} is 2/4.
		expect(similarAsks("¿uno dos tres cuatro cinco?", "¿uno dos tres cuatro seis?")).toBe(false);
		expect(similarAsks("¿alfa beta gamma?", "¿alfa beta gamma delta omega?")).toBe(true); // 3/5
		expect(similarAsks("¿alfa beta gamma?", "¿alfa beta gamma delta omega sigma?")).toBe(false); // 3/6
	});

	it("does not suggest for an ask that is already linked, nor point at a closed ask", () => {
		const rows = buildPending([
			user("a"),
			assistant("¿Los borro?", { id: "ddddddd1" }),
			user("b"),
			assistant("¿Los borro?", { id: "ddddddd2" }),
			askEntry({ action: "dismiss", ask: "ddddddd1.1" }),
			user("c"),
			assistant("¿Los borro?", { id: "ddddddd3" }),
			askEntry({ action: "link", ask: "ddddddd3.1", continues: "ddddddd2.1" }),
		]);
		expect(rows.map((ask) => [ask.ordinal, ask.suggestion?.ordinal])).toEqual([["P3.R1.Q1", undefined]]);
		const lone = buildPending([
			user("a"),
			assistant("¿Los borro?", { id: "eeeeeee1" }),
			askEntry({ action: "dismiss", ask: "eeeeeee1.1" }),
			user("b"),
			assistant("¿Los borro?", { id: "eeeeeee2" }),
		]);
		expect(lone.map((ask) => ask.suggestion?.ordinal)).toEqual([undefined]);
	});

	it("normalizes: lowercase, inline code and punctuation removed, spaces collapsed", () => {
		expect(normalizeAsk("  ¿Corro `pnpm test`   AHORA, sí?  ")).toBe("corro ahora sí");
		expect(similarAsks("?", "¿?")).toBe(false);
	});
});

describe("buildAsks: closed asks", () => {
	const base = () => [user("hola"), assistant("¿Uno?\n\n¿Dos?", { id: "a1b2c3d4" })];
	const closed = (entries: Parameters<typeof buildAsks>[0]) =>
		buildAsks(entries).closed.map(({ ask, chain, closedBy }) => [
			ask.ordinal,
			chain.map((member) => member.ordinal),
			closedBy.kind === "answer" ? `P${closedBy.prompt.prompt}` : closedBy.kind,
		]);

	it("returns the open asks as buildPending does, and no closed ones while nothing closed", () => {
		const entries = base();
		expect(buildAsks(entries).pending).toEqual(buildPending(entries));
		expect(closed(entries)).toEqual([]);
	});

	it("tells an ask answered by the prompt that cites it from one dismissed, oldest first", () => {
		const entries = [...base(), askEntry({ action: "dismiss", ask: "a1b2c3d4.2" }), user("> P1.R1.Q1: ¿Uno?\nR: sí")];
		expect(closed(entries)).toEqual([
			["P1.R1.Q1", [], "P2"],
			["P1.R1.Q2", [], "dismiss"],
		]);
		expect(buildAsks(entries).pending).toEqual([]);
	});

	it("keeps the first prompt that answered an ask, and drops a reopened ask from the closed ones", () => {
		const entries = [...base(), user("P1.R1.Q1 sí"), user("P1.R1.Q1 otra vez")];
		expect(closed(entries)).toEqual([["P1.R1.Q1", [], "P2"]]);
		const reopened = [...base(), askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }), askEntry({ action: "reopen", ask: "a1b2c3d4.1" })];
		expect(closed(reopened)).toEqual([]);
	});

	it("closes a chain once, on its newest member, with how its first member closed", () => {
		const entries = [
			user("a"),
			assistant("¿Los borro?", { id: "aaaaaaa1" }),
			user("b"),
			assistant("¿Los borro todos?", { id: "aaaaaaa2" }),
			askEntry({ action: "link", ask: "aaaaaaa2.1", continues: "aaaaaaa1.1" }),
			user("> P1.R1.Q1: ¿Los borro?\nR: sí"),
		];
		expect(closed(entries)).toEqual([["P2.R1.Q1", ["P1.R1.Q1"], "P3"]]);
	});
});

describe("buildAsks: answer text", () => {
	const base = () => [user("hola"), assistant("¿Uno?\n\n¿Dos?", { id: "a1b2c3d4" })];
	const answers = (prompt: string) =>
		buildAsks([...base(), user(prompt)]).closed.map(({ ask, closedBy }) => [
			ask.ordinal,
			closedBy.kind === "answer" ? closedBy.text : closedBy.kind,
		]);

	it("lines: the R: line under the cited quote, trimmed, empty when nothing follows R:", () => {
		expect(answers("> P1.R1.Q1: ¿Uno?\nR:  sí, dale  \n\n> P1.R1.Q2: ¿Dos?\nR: ")).toEqual([
			["P1.R1.Q1", "sí, dale"],
			["P1.R1.Q2", ""],
		]);
	});

	it("inline: the text after → on the quote line, even when the next line is another quote with R:", () => {
		expect(answers("> P1.R1.Q1: ¿Uno? → Yes.\n> P1.R1.Q2: ¿Dos? → no → nunca")).toEqual([
			["P1.R1.Q1", "Yes."],
			["P1.R1.Q2", "no → nunca"],
		]);
		expect(answers("> P1.R1.Q1: ¿Uno? → a\n> P1.R1.Q2: ¿Dos?\nR: b")).toEqual([
			["P1.R1.Q1", "a"],
			["P1.R1.Q2", "b"],
		]);
	});

	it("a plain prompt: the first non-quote, non-empty line after the quote", () => {
		expect(answers("> P1.R1.Q1: ¿Uno?\n> sigue la cita\n\nLa primera.\nY algo más.")).toEqual([["P1.R1.Q1", "La primera."]]);
	});

	it("a quote with nothing after it, or a prompt that only cites the ID: the prompt's first line", () => {
		expect(answers("\n  dale con a1b2c3d4.2  \nsegunda línea")).toEqual([["P1.R1.Q2", "dale con a1b2c3d4.2"]]);
		expect(answers("Contesto abajo.\n> P1.R1.Q1: ¿Uno?")).toEqual([["P1.R1.Q1", "Contesto abajo."]]);
	});
});
