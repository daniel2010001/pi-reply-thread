import { beforeEach, describe, expect, it } from "vitest";
import { answerText } from "../src/format.ts";
import { buildAsks, buildPending, groupLinks, normalizeAsk, questionIds, similarAsks, similarGroups } from "../src/pending.ts";
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

describe("similarGroups: repeat groups", () => {
	const repeats = () => [
		user("a"),
		assistant("¿Los borro?", { id: "fffffff1" }),
		user("b"),
		assistant("¿Pusheo la rama?", { id: "fffffff2" }),
		user("c"),
		assistant("**¿Los BORRO?**", { id: "fffffff3" }),
		user("d"),
		assistant("los borro?", { id: "fffffff4" }),
	];
	const groups = (entries: Parameters<typeof buildPending>[0]) =>
		similarGroups(buildPending(entries)).map((group) => group.map((row) => row.ordinal));

	it("folds three similar open asks into one group, oldest first, and leaves a lone ask alone", () => {
		expect(groups(repeats())).toEqual([["P2.R1.Q1"], ["P1.R1.Q1", "P3.R1.Q1", "P4.R1.Q1"]]);
	});

	it("joins asks through a common repeat even when the two ends are not similar themselves", () => {
		const entries = [
			user("a"),
			// {alfa, beta, gamma} and {alfa, beta, gamma, delta, omega}: 3/5; that and {gamma, delta, omega, sigma, kappa}: 3/7.
			assistant("¿alfa beta gamma?", { id: "fffffff1" }),
			user("b"),
			assistant("¿alfa beta gamma delta omega?", { id: "fffffff2" }),
			user("c"),
			assistant("¿beta gamma delta omega?", { id: "fffffff3" }),
		];
		expect(similarAsks("¿alfa beta gamma?", "¿beta gamma delta omega?")).toBe(false);
		expect(groups(entries)).toEqual([["P1.R1.Q1", "P2.R1.Q1", "P3.R1.Q1"]]);
	});

	it("counts a chain row by its newest text, and never groups a closed ask", () => {
		const chained = [
			...repeats(),
			askEntry({ action: "link", ask: "fffffff2.1", continues: "fffffff1.1" }),
		];
		// The chain P1.R1.Q1 → P2.R1.Q1 reads as "¿Pusheo la rama?", its newest text.
		expect(groups(chained)).toEqual([["P2.R1.Q1"], ["P3.R1.Q1", "P4.R1.Q1"]]);
		const closed = [...repeats(), askEntry({ action: "dismiss", ask: "fffffff3.1" }), user("> P4.R1.Q1: los borro?\nR: no")];
		expect(groups(closed)).toEqual([["P1.R1.Q1"], ["P2.R1.Q1"]]);
	});

	it("closes nothing by itself: grouping leaves every member open, and answering the newest leaves the rest", () => {
		const state = buildAsks(repeats());
		expect(state.closed).toEqual([]);
		expect(state.pending).toHaveLength(4);
		expect(groups([...repeats(), user("> P4.R1.Q1: los borro?\nR: sí")])).toEqual([["P2.R1.Q1"], ["P1.R1.Q1", "P3.R1.Q1"]]);
	});
});

describe("groupLinks: linking a group to its root", () => {
	const repeats = () => [
		user("a"),
		assistant("¿Los borro?", { id: "fffffff1" }),
		user("b"),
		assistant("**¿Los BORRO?**", { id: "fffffff2" }),
		user("c"),
		assistant("los borro?", { id: "fffffff3" }),
	];

	it("links every other member to the oldest one, star-shaped, and the group becomes one chain row", () => {
		const [group] = similarGroups(buildPending(repeats()));
		const links = groupLinks(group);
		expect(links).toEqual([
			{ action: "link", ask: "fffffff2.1", continues: "fffffff1.1" },
			{ action: "link", ask: "fffffff3.1", continues: "fffffff1.1" },
		]);
		const rows = buildPending([...repeats(), ...links.map((link) => askEntry(link))]);
		expect(rows.map((row) => [row.ordinal, row.chain.map((member) => member.ordinal), row.continues])).toEqual([
			["P3.R1.Q1", ["P1.R1.Q1", "P2.R1.Q1"], "fffffff1.1"],
		]);
	});

	it("links nothing for a lone ask", () => {
		const [lone] = similarGroups(buildPending(repeats().slice(0, 2)));
		expect(groupLinks(lone)).toEqual([]);
	});

	it("hangs a chain member by its oldest ask and keeps the chain as it was built", () => {
		const entries = [
			user("a"),
			assistant("¿Los borro?", { id: "fffffff1" }),
			user("b"),
			assistant("¿Pusheo la rama?", { id: "fffffff2" }),
			user("c"),
			assistant("Ya. ¿Los borro?", { id: "fffffff3" }),
			// A chain marked by hand (T19): P2.R1.Q1 → P1.R1.Q1 is not a repeat, P3.R1.Q1 → P2.R1.Q1 a path.
			askEntry({ action: "link", ask: "fffffff2.1", continues: "fffffff1.1" }),
			askEntry({ action: "link", ask: "fffffff3.1", continues: "fffffff2.1" }),
			user("d"),
			assistant("**¿Los BORRO?**", { id: "fffffff4" }),
			user("e"),
			assistant("los borro?", { id: "fffffff5" }),
		];
		const [group] = similarGroups(buildPending(entries));
		expect(group.map((row) => row.ordinal)).toEqual(["P3.R1.Q1", "P4.R1.Q1", "P5.R1.Q1"]);
		const links = groupLinks(group);
		expect(links).toEqual([
			{ action: "link", ask: "fffffff4.1", continues: "fffffff1.1" },
			{ action: "link", ask: "fffffff5.1", continues: "fffffff1.1" },
		]);
		const [row] = buildPending([...entries, ...links.map((link) => askEntry(link))]);
		expect(row.ordinal).toBe("P5.R1.Q1");
		expect(row.chain.map((member) => member.ordinal)).toEqual(["P1.R1.Q1", "P2.R1.Q1", "P3.R1.Q1", "P4.R1.Q1"]);
		// The hand-made path is unchanged: unlinking P3 from P2 still splits it there.
		const split = buildPending([
			...entries,
			...links.map((link) => askEntry(link)),
			askEntry({ action: "unlink", ask: "fffffff3.1", continues: "fffffff2.1" }),
		]);
		expect(split.map((ask) => ask.ordinal)).toEqual(["P3.R1.Q1", "P5.R1.Q1"]);
	});
});

describe("buildAsks: a quote closes the ask whose text it carries", () => {
	/** A decision section renumbers its items: the old Q3 text is now Q4 (L41). */
	const renumbered = () => [
		user("go"),
		assistant(
			[
				"Should I rebase first?",
				"",
				"## Needs your decision",
				"",
				"1. Do I commit T26?",
				"2. Do I align the plain index?",
				"3. Only top-level items?",
				"4. Do I merge `feat/pending-central` into main?",
			].join("\n"),
			{ id: "a1b2c3d4" },
		),
	];
	const MERGE = "Do I merge `feat/pending-central` into main?";
	const state = (prompt: string, entries = renumbered()) => {
		const { pending, closed } = buildAsks([...entries, user(prompt)]);
		return {
			open: pending.map((ask) => ask.ordinal),
			closed: closed.map(({ ask, closedBy }) => [ask.ordinal, closedBy.kind === "answer" ? closedBy.text : closedBy.kind]),
		};
	};

	it("closes the ask the quote carries, not the one its renumbered ID names now", () => {
		expect(state(`> P1.R1.Q3: ${MERGE}\nR: yes, after I test it`)).toEqual({
			open: ["P1.R1.Q1", "P1.R1.Q2", "P1.R1.Q3"],
			closed: [["P1.R1.Q4", "yes, after I test it"]],
		});
		// By the unique ID, or an ID that names no ask at all.
		expect(state(`> a1b2c3d4.3: ${MERGE}\nR: yes`).open).toEqual(["P1.R1.Q1", "P1.R1.Q2", "P1.R1.Q3"]);
		expect(state(`> P1.R1.Q9: ${MERGE}\nR: yes`).open).toEqual(["P1.R1.Q1", "P1.R1.Q2", "P1.R1.Q3"]);
	});

	it("matches the quoted text as normalizeAsk does, whatever its case and punctuation", () => {
		expect(state("> P1.R1.Q3: do i MERGE `feat/pending-central` into main\nR: yes").closed).toEqual([["P1.R1.Q4", "yes"]]);
	});

	it("closes the newest matching ask before the prompt, not a later one, and the one the ID names when it matches", () => {
		const repeats = [
			user("a"),
			assistant("¿Los borro?", { id: "bbbbbbb1" }),
			user("b"),
			assistant("Listo. ¿Pusheo?\n\n¿Los borro?", { id: "bbbbbbb2" }),
		];
		const after = [user("c"), assistant("¿Los borro?", { id: "bbbbbbb3" })];
		const open = (prompt: string) => buildPending([...repeats, user(prompt), ...after]).map((ask) => ask.ordinal);
		expect(open("> P9.R9.Q9: ¿Los borro?\nR: sí")).toEqual(["P1.R1.Q1", "P2.R1.Q1", "P4.R1.Q1"]);
		expect(open("> P2.R1.Q1: ¿Los borro?\nR: sí")).toEqual(["P1.R1.Q1", "P2.R1.Q1", "P4.R1.Q1"]);
		// The ID names an open ask with that text, so it closes that one: what answering a repeat from the central pastes.
		expect(open("> P1.R1.Q1: ¿Los borro?\nR: sí")).toEqual(["P2.R1.Q1", "P2.R1.Q2", "P4.R1.Q1"]);
	});

	it("falls back to the ID when nothing follows the colon, or the text matches no ask", () => {
		expect(state("> P1.R1.Q3:\nR: yes")).toEqual({
			open: ["P1.R1.Q1", "P1.R1.Q2", "P1.R1.Q4"],
			closed: [["P1.R1.Q3", "yes"]],
		});
		expect(state("> P1.R1.Q3: Something I wrote myself?\nR: no").closed).toEqual([["P1.R1.Q3", "no"]]);
	});

	it("does not fall back to the ID when the text matches an ask that is already closed", () => {
		const answered = [...renumbered(), user(`> P1.R1.Q4: ${MERGE}\nR: yes`)];
		expect(state(`> P1.R1.Q3: ${MERGE}\nR: yes again`, answered)).toEqual({
			open: ["P1.R1.Q1", "P1.R1.Q2", "P1.R1.Q3"],
			closed: [["P1.R1.Q4", "yes"]],
		});
	});

	it("closes by text in both paste formats and reads each answer from its own quote", () => {
		const lines = `> P1.R1.Q3: ${MERGE}\nR: later\n\n> P1.R1.Q2: Only top-level items?\nR: yes`;
		expect(state(lines)).toEqual({
			open: ["P1.R1.Q1", "P1.R1.Q2"],
			closed: [
				["P1.R1.Q3", "yes"],
				["P1.R1.Q4", "later"],
			],
		});
		const inline = `> P1.R1.Q3: ${MERGE} → later\n> P1.R1.Q2: Only top-level items? → \n> P1.R1.Q1: Do I align the plain index? → no → never`;
		expect(state(inline)).toEqual({
			open: ["P1.R1.Q1"],
			closed: [
				["P1.R1.Q2", "no → never"],
				["P1.R1.Q3", ""],
				["P1.R1.Q4", "later"],
			],
		});
	});

	it("keeps an ask whose own text holds → whole", () => {
		const entries = [user("go"), assistant("¿Paso de A → B?", { id: "a1b2c3d4" }), user("x"), assistant("¿Otra?")];
		expect(state("> P9.R9.Q9: ¿Paso de A → B? → sí", entries)).toEqual({ open: ["P2.R1.Q1"], closed: [["P1.R1.Q1", "sí"]] });
	});

	it("still closes by ID a mention outside a quote, and an ID the quote does not carry", () => {
		expect(state("P1.R1.Q3 yes").closed).toEqual([["P1.R1.Q3", "P1.R1.Q3 yes"]]);
		expect(state(`> P1.R1.Q3: ${MERGE}\nR: yes\n\nAnd P1.R1.Q3: no.`).closed).toEqual([
			// A citation outside a quote answers with the prompt's first line, as before.
			["P1.R1.Q3", `> P1.R1.Q3: ${MERGE}`],
			["P1.R1.Q4", "yes"],
		]);
	});
});
