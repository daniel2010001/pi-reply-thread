import { describe, expect, it } from "vitest";
import { detectOpenAsks } from "../src/asks.ts";

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
		expect(detectOpenAsks("## Needs your decision\n\n- A or B")).toEqual(["Needs your decision"]);
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
			detectOpenAsks(["## Needs your decision", "- A or B", "", "### Details", "", "¿Seguimos?"].join("\n")),
		).toEqual(["Needs your decision", "¿Seguimos?"]);
		expect(
			detectOpenAsks(["# Necesito tu OK", "- A", "## ¿Por qué?", "Porque sí.", "## Needs your decision", "- Ship it?"].join("\n")),
		).toEqual(["Necesito tu OK", "Ship it?"]);
	});
});

