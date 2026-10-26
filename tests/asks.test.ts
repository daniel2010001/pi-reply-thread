import { describe, expect, it } from "vitest";
import { detectOpenAsks, untrackedAsks } from "../src/asks.ts";
import { questionIds } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { assistant, user } from "./helpers.ts";

describe("detectOpenAsks", () => {
	it("takes a line ending in a question mark as an ask", () => {
		expect(detectOpenAsks("Tests are green.\nShould I open the PR?\nDone.")).toEqual(["Should I open the PR?"]);
	});

	it("takes a Spanish ¿…? question as an ask", () => {
		expect(detectOpenAsks("Encontré dos opciones. ¿Cuál preferís?")).toEqual(["Encontré dos opciones. ¿Cuál preferís?"]);
	});

	it("still counts a question mark followed by closing emphasis, parentheses or quotes", () => {
		expect(
			detectOpenAsks(
				[
					"**Do you want both?**",
					"_¿Seguimos?_",
					"(merge now?)",
					'He asked "ship it?"',
					"Ella dijo «¿lo publico?»",
					"Pick one: 'a or b?'",
				].join("\n"),
			),
		).toEqual(["Do you want both?", "¿Seguimos?", "(merge now?)", 'He asked "ship it?"', "Ella dijo «¿lo publico?»", "Pick one: 'a or b?'"]);
	});

	it("takes each English decision marker as an ask, case-insensitive", () => {
		expect(
			detectOpenAsks(
				[
					"Needs your decision: pick the TTS engine.",
					"DECISION NEEDED on the audio routing.",
					"Waiting on you for the npm OK.",
					"I am waiting for you to confirm.",
				].join("\n"),
			),
		).toEqual([
			"Needs your decision: pick the TTS engine.",
			"DECISION NEEDED on the audio routing.",
			"Waiting on you for the npm OK.",
			"I am waiting for you to confirm.",
		]);
	});

	it("takes each Spanish decision marker as an ask, case-insensitive", () => {
		expect(
			detectOpenAsks(
				[
					"Necesito que decidas el motor de voz.",
					"Necesito tu OK para publicar.",
					"Necesito tu decisión sobre el widget.",
					"necesito tu decision sobre el nombre.",
					"Necesito tu confirmación antes de borrar.",
					"necesito tu confirmacion para seguir.",
				].join("\n"),
			),
		).toEqual([
			"Necesito que decidas el motor de voz.",
			"Necesito tu OK para publicar.",
			"Necesito tu decisión sobre el widget.",
			"necesito tu decision sobre el nombre.",
			"Necesito tu confirmación antes de borrar.",
			"necesito tu confirmacion para seguir.",
		]);
	});

	it("ignores questions and markers inside ``` fenced code", () => {
		expect(detectOpenAsks("Run this:\n```ts\nconst ok = ready ? 1 : 0; // ready?\n// needs your decision\n```\nDone.")).toEqual([]);
	});

	it("ignores questions inside ~~~ fenced code and resumes after the fence", () => {
		expect(detectOpenAsks("~~~\nwhat?\n```\nstill code?\n~~~\nAnd now?")).toEqual(["And now?"]);
	});

	it("ignores blockquote lines", () => {
		expect(detectOpenAsks("> Should we ship it?\n> Needs your decision\nQuoted above.")).toEqual([]);
	});

	it("ignores table rows", () => {
		expect(detectOpenAsks("| Option | Ready? |\n|---|---|\n| a | yes? |")).toEqual([]);
	});

	it("ignores a question mark inside an inline code span", () => {
		expect(detectOpenAsks("Use `a ?? b`\nThe flag is `--dry-run?`\nRun `ls`, ok?")).toEqual(["Run `ls`, ok?"]);
	});

	it("strips bullets, heading marks and emphasis from the returned line", () => {
		expect(
			detectOpenAsks(
				[
					"- **Merge** now?",
					"* ¿Seguimos?",
					"+ __Ship__ it?",
					"1. Keep the *old* name?",
					"2) Drop it?",
					"- [ ] Approve the plan?",
					"## Needs your decision",
				].join("\n"),
			),
		).toEqual([
			"Merge now?",
			"¿Seguimos?",
			"Ship it?",
			"Keep the old name?",
			"Drop it?",
			"Approve the plan?",
			"Needs your decision",
		]);
	});

	it("keeps snake_case and inline code intact while stripping emphasis", () => {
		expect(detectOpenAsks("Rename **`open_asks`** to snake_case_name?")).toEqual(["Rename `open_asks` to snake_case_name?"]);
	});

	it("keeps the asks in the order they appear", () => {
		expect(detectOpenAsks("Second thing?\nNeeds your decision: first.\nThird?")).toEqual([
			"Second thing?",
			"Needs your decision: first.",
			"Third?",
		]);
	});

	it("removes duplicate asks, comparing the cleaned lines", () => {
		expect(detectOpenAsks("Ship it?\n- **Ship it?**\nOther?\nShip it?")).toEqual(["Ship it?", "Other?"]);
	});

	it("returns [] for a reply with no asks", () => {
		expect(detectOpenAsks("Tests are green.\n\n- The PR is open.\n## Summary")).toEqual([]);
		expect(detectOpenAsks("")).toEqual([]);
	});

	it("does not take a decision marker that is only quoted as an ask", () => {
		expect(
			detectOpenAsks(
				[
					'Detecta marcadores como "Needs your decision" y "necesito tu OK".',
					"El aviso “waiting on you” sale en el widget.",
					"La frase «necesito que decidas» también cuenta.",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("still takes a marker next to a quote, and a quoted question at the end of a line", () => {
		expect(
			detectOpenAsks(['Needs your decision: "A" or "B".', 'He asked "ship it?"'].join("\n")),
		).toEqual(['Needs your decision: "A" or "B".', 'He asked "ship it?"']);
	});

	it("takes a heading that ends in a question mark as a section title, not an ask", () => {
		expect(
			detectOpenAsks(
				[
					"## ¿Y un subagente especializado?",
					"### *Which engine?*",
					"Puede servir, pero no para controlar la central.",
					"# Why not a model?",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("still takes a decision marker in a heading as an ask when no ask is under it", () => {
		expect(detectOpenAsks("## Needs your decision\n\nPick when you can.")).toEqual(["Needs your decision"]);
		expect(detectOpenAsks("Done.\n\n## Necesito tu OK")).toEqual(["Necesito tu OK"]);
		expect(detectOpenAsks("## Needs your decision\n\n```\nship it?\n```\n> Merge?\n| A? |")).toEqual(["Needs your decision"]);
	});

	it("takes a marker heading with asks under it as the title of its section, not an ask", () => {
		expect(
			detectOpenAsks(
				["Tests are green.", "", "## Needs your decision", "", "- Merge now?", "- Necesito tu OK para pushear."].join("\n"),
			),
		).toEqual(["Merge now?", "Necesito tu OK para pushear."]);
		expect(detectOpenAsks("### **Necesito tu decisión**\n\n1. ¿Borro las ramas?")).toEqual(["¿Borro las ramas?"]);
	});

	it("does not count an ask under a later heading, of any level, for an earlier marker heading", () => {
		expect(
			detectOpenAsks(["## Needs your decision", "Pick one.", "", "### Details", "", "¿Seguimos?"].join("\n")),
		).toEqual(["Needs your decision", "¿Seguimos?"]);
		expect(
			detectOpenAsks(
				["# Necesito tu OK", "Para pushear.", "## ¿Por qué?", "Porque sí.", "## Needs your decision", "- Ship it?"].join("\n"),
				"all",
			),
		).toEqual(["Necesito tu OK", "Ship it?"]);
		expect(
			detectOpenAsks(["# Necesito tu OK", "Para pushear.", "## Needs your decision", "- Ship it?"].join("\n")),
		).toEqual(["Ship it?"]);
	});

	it("takes every bullet or numbered item of a marker section as an ask, even without ?, and not the heading", () => {
		expect(
			detectOpenAsks(
				[
					"Tests are green.",
					"",
					"## Needs your decision",
					"",
					"1. **Merge** `feat/x` into main",
					"2) Keep the old name",
					"- [ ] Push the tag",
					"* A or B",
					"+ Ship it?",
					"  - Nested: drop the draft",
					"Plain text under the heading.",
				].join("\n"),
			),
		).toEqual(["Merge `feat/x` into main", "Keep the old name", "Push the tag", "A or B", "Ship it?"]);
		expect(detectOpenAsks("### **Necesito tu decisión**\n\n- Borrar las ramas\n- Borrar las ramas")).toEqual(["Borrar las ramas"]);
	});

	it("does not take an item under a later non-marker heading, nor items of a plain section, nor one in code", () => {
		expect(
			detectOpenAsks(
				["## Summary", "- Tests pass", "## Needs your decision", "- Merge now", "```", "- not an item", "```", "### Details", "- A detail", "## Next", "1. Release"].join("\n"),
			),
		).toEqual(["Merge now"]);
	});
});

describe("detectOpenAsks modes", () => {
	const reply = [
		"Tests are green. Should I also bump the version?",
		"",
		"## Why not a model?",
		"",
		"Does it need one? No, the rule is enough.",
		"",
		"## Needs your decision",
		"",
		"1. Merge `feat/x` into main? It is green.",
		"2. Keep the old name",
		"Which tag do you want?",
		"Plain context under the items.",
		"",
		"## Next",
		"",
		"Want the release notes too?",
	].join("\n");

	it("section mode, the default, keeps only the decision section's top-level items and ? lines", () => {
		const section = ["Merge `feat/x` into main? It is green.", "Keep the old name", "Which tag do you want?"];
		expect(detectOpenAsks(reply)).toEqual(section);
		expect(detectOpenAsks(reply, "section")).toEqual(section);
	});

	it("numbers the asks of the decision section like its items, so Q# is the item number", () => {
		const items = ["1. Merge now? It is green.", "2. Keep the old name", "3. Tag it, or not?"];
		const text = ["Context first: should I rebase?", "", "## Needs your decision", "", ...items].join("\n");
		const [thread] = buildThreads([user("go"), assistant(text, { id: "a1b2c3d4" })]);
		expect(questionIds(thread.replies[0]).map((ask) => [ask.ordinal, ask.text])).toEqual([
			["P1.R1.Q1", "Merge now? It is green."],
			["P1.R1.Q2", "Keep the old name"],
			["P1.R1.Q3", "Tag it, or not?"],
		]);
	});

	it("does not take a nested item as an ask by the item rule: 4+ spaces or a second list level", () => {
		const text = [
			"## Needs your decision",
			"   - Three spaces is still the top level",
			"- Merge now",
			"  - with a squash",
			"  - Squash it?",
			"    - Four spaces is nested",
			"\t- A tab is nested",
			"1. Release",
			"   - Under a numbered item",
		].join("\n");
		expect(detectOpenAsks(text)).toEqual(["Three spaces is still the top level", "Merge now", "Release"]);
		expect(detectOpenAsks(text, "all")).toEqual(["Three spaces is still the top level", "Merge now", "Squash it?", "Release"]);
	});

	it("keeps today's rules for a reply without a decision section, in both modes", () => {
		const text = ["Ship it?", "- Merge now?", "  - Nested too?", "- A plain item", "## Summary", "Done. Anything else?"].join("\n");
		expect(detectOpenAsks(text)).toEqual(["Ship it?", "Merge now?", "Nested too?", "Done. Anything else?"]);
		expect(detectOpenAsks(text, "all")).toEqual(detectOpenAsks(text));
		expect(untrackedAsks(text)).toBe(0);
	});

	it("keeps today's rules for a marker section with no ask: the heading counts, with the questions elsewhere", () => {
		const text = ["Merge?", "", "## Needs your decision", "", "Pick when you can."].join("\n");
		expect(detectOpenAsks(text)).toEqual(["Merge?", "Needs your decision"]);
		expect(detectOpenAsks(text, "all")).toEqual(["Merge?", "Needs your decision"]);
		expect(untrackedAsks(text)).toBe(0);
	});

	it("all mode keeps the questions outside the section and the section's top-level items", () => {
		expect(detectOpenAsks(reply, "all")).toEqual([
			"Tests are green. Should I also bump the version?",
			"Merge `feat/x` into main? It is green.",
			"Keep the old name",
			"Which tag do you want?",
			"Want the release notes too?",
		]);
	});

	it("counts the asks section mode leaves outside the decision section, once each, and none in all mode", () => {
		expect(untrackedAsks(reply)).toBe(2);
		expect(untrackedAsks(reply, "section")).toBe(2);
		expect(untrackedAsks(reply, "all")).toBe(0);
		const repeated = ["Ship it?", "Ship it?", "## Needs your decision", "- Ship it?", "- Tag it"].join("\n");
		expect(detectOpenAsks(repeated)).toEqual(["Ship it?", "Tag it"]);
		expect(untrackedAsks(repeated)).toBe(0);
		const one = ["Ship it?", "## Needs your decision", "- Tag it"].join("\n");
		expect(untrackedAsks(one)).toBe(1);
	});
});
