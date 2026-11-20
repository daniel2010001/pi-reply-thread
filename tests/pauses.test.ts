import { beforeEach, describe, expect, it } from "vitest";
import { indexRows } from "../src/format.ts";
import { findReply } from "../src/lookup.ts";
import { buildAsks, openIds, questionIds } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { askEntry, assistant, resetIds, toolCalls, toolResultOf, user, wake } from "./helpers.ts";

beforeEach(() => resetIds());

const QUESTIONS = {
	questions: [
		{ header: "Branch", question: "¿Borro la rama vieja?", options: [{ label: "Sí, adelante" }, { label: "No" }] },
		{ header: "Docs", question: "¿Qué docs actualizo?", multiSelect: true, options: [{ label: "README" }, { label: "CHANGELOG" }] },
		{ header: "Voice", question: "¿Qué voz uso?", options: [{ label: "Piper" }, { label: "Otra" }] },
	],
};

const QUESTIONS_TEXT = [
	"1. ¿Borro la rama vieja? — Sí, adelante",
	"2. ¿Qué docs actualizo? — selected: README, CHANGELOG",
	"3. ¿Qué voz uso? — (custom) la de siempre",
].join("\n");

const QUESTIONS_DETAILS = {
	answers: [
		{ questionIndex: 0, question: "¿Borro la rama vieja?", kind: "option", answer: "Sí, adelante" },
		{ questionIndex: 1, question: "¿Qué docs actualizo?", kind: "multi", answer: null, selected: ["README", "CHANGELOG"] },
		{ questionIndex: 2, question: "¿Qué voz uso?", kind: "custom", answer: "la de siempre" },
	],
};

const CHOICE = {
	question: "¿Dónde versiono la config?",
	options: [
		{ label: "Versioned in compose (recommended)", value: "compose" },
		{ label: "Aparte", value: "apart" },
	],
};

const CHOICE_TEXT = "User selected: 1. Versioned in compose (recommended) (value: compose)";
const CHOICE_DETAILS = { question: CHOICE.question, options: CHOICE.options, selection: { value: "compose", label: "Versioned in compose (recommended)", index: 1 } };

describe("pauses: ask tools inside a turn", () => {
	it("adds ask_user_question answers to the next final reply, after its text asks, without renumbering replies", () => {
		const threads = buildThreads([
			user("arrancá"),
			assistant("Primero esto. ¿Seguimos?", { id: "aaaaaaa1" }),
			toolCalls([{ id: "call-q", name: "ask_user_question", arguments: QUESTIONS }]),
			toolResultOf("call-q", "ask_user_question", QUESTIONS_TEXT, { details: QUESTIONS_DETAILS }),
			assistant("Hecho. ¿Pusheo?\n\n¿Publico?", { id: "aaaaaaa2" }),
		]);
		expect(threads[0].replies.map((reply) => reply.ordinal)).toEqual(["P1.R1", "P1.R2"]);
		const [first, second] = threads[0].replies;
		expect(first.pauses).toEqual([]);
		expect(second.openAsks).toEqual(["Hecho. ¿Pusheo?", "¿Publico?"]);
		expect(second.pauses).toEqual([
			{ text: "¿Borro la rama vieja?", answer: "Sí, adelante" },
			{ text: "¿Qué docs actualizo?", answer: "README, CHANGELOG" },
			{ text: "¿Qué voz uso?", answer: "la de siempre" },
		]);
		expect(questionIds(second)).toEqual([
			{ ordinal: "P1.R2.Q1", id: "aaaaaaa2.1", text: "Hecho. ¿Pusheo?" },
			{ ordinal: "P1.R2.Q2", id: "aaaaaaa2.2", text: "¿Publico?" },
			{ ordinal: "P1.R2.Q3", id: "aaaaaaa2.3", text: "¿Borro la rama vieja?" },
			{ ordinal: "P1.R2.Q4", id: "aaaaaaa2.4", text: "¿Qué docs actualizo?" },
			{ ordinal: "P1.R2.Q5", id: "aaaaaaa2.5", text: "¿Qué voz uso?" },
		]);
	});

	it("reads ask_user_choice by its selection label", () => {
		const [thread] = buildThreads([
			user("config"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses).toEqual([
			{ text: "¿Dónde versiono la config?", answer: "Versioned in compose (recommended)" },
		]);
	});

	it("falls back to the result text when the result has no details", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([
				{ id: "call-q", name: "ask_user_question", arguments: QUESTIONS },
				{ id: "call-c", name: "ask_user_choice", arguments: CHOICE },
			]),
			toolResultOf("call-q", "ask_user_question", QUESTIONS_TEXT),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses.map((pause) => pause.answer)).toEqual([
			"Sí, adelante",
			"selected: README, CHANGELOG",
			"(custom) la de siempre",
			"Versioned in compose (recommended)",
		]);
	});

	it("answers with the result's first line when it has no known shape", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-c", "ask_user_choice", "User cancelled the selection.\nNothing chosen."),
			assistant("Ok, lo dejo."),
		]);
		expect(thread.replies[0].pauses).toEqual([{ text: "¿Dónde versiono la config?", answer: "User cancelled the selection." }]);
	});

	it("skips a failed call, a pause no final reply follows in its thread, and other tools", () => {
		const threads = buildThreads([
			user("uno"),
			toolCalls([{ id: "call-bad", name: "ask_user_question", arguments: QUESTIONS }]),
			toolResultOf("call-bad", "ask_user_question", 'Validation failed for tool "ask_user_question"', { isError: true }),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "ls" } }]),
			toolResultOf("call-b", "bash", "README.md"),
			assistant("Listo."),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			user("dos"),
			assistant("Ok."),
		]);
		expect(threads.flatMap((thread) => thread.replies.map((reply) => reply.pauses))).toEqual([[], []]);
	});

	it("keeps a pause across a gentle-agents wake: the reply after the wake holds it", () => {
		const [thread] = buildThreads([
			user("uno"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			assistant("", { stopReason: "aborted" }),
			...wake("n1"),
			assistant("Retomo."),
		]);
		expect(thread.replies.map((reply) => [reply.ordinal, reply.pauses.length])).toEqual([["P1.R1", 1]]);
	});
});

describe("pauses: closed from the start", () => {
	const branch = () => [
		user("arrancá"),
		toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
		toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
		assistant("Versionado. ¿Pusheo?", { id: "bbbbbbb1" }),
	];

	it("closes a pause ask with the chosen answer; the reply's text asks stay open", () => {
		const state = buildAsks(branch());
		expect(state.pending.map((ask) => ask.ordinal)).toEqual(["P1.R1.Q1"]);
		expect(state.closed.map((row) => [row.ask.ordinal, row.ask.text, row.closedBy])).toEqual([
			["P1.R1.Q2", "¿Dónde versiono la config?", { kind: "pause", text: "Versioned in compose (recommended)" }],
		]);
	});

	it("ignores reopen and dismiss entries for a pause ask", () => {
		const entries = [
			...branch(),
			askEntry({ action: "reopen", ask: "bbbbbbb1.2" }),
			askEntry({ action: "dismiss", ask: "bbbbbbb1.2" }),
		];
		const state = buildAsks(entries);
		expect(state.pending.map((ask) => ask.ordinal)).toEqual(["P1.R1.Q1"]);
		expect(state.closed.map((row) => row.closedBy)).toEqual([{ kind: "pause", text: "Versioned in compose (recommended)" }]);
	});

	it("finds the reply of a pause ask by either question ID", () => {
		const threads = buildThreads(branch());
		expect(findReply(threads, "P1.R1.Q2")?.entryId).toBe("bbbbbbb1");
		expect(findReply(threads, "bbbbbbb1.2")?.entryId).toBe("bbbbbbb1");
		expect(findReply(threads, "P1.R1.Q3")).toBeUndefined();
	});

	it("marks a reply whose only asks are pauses with ✓ in the plain index, with or without the open asks", () => {
		const entries = [
			user("x"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			assistant("Listo.", { id: "ccccccc1" }),
		];
		const threads = buildThreads(entries);
		const open = openIds(buildAsks(entries, threads).pending);
		expect(indexRows(threads, open).map((row) => row.text)[1]).toBe("P1.R1  ccccccc1  prompt  ✓");
		expect(indexRows(threads).map((row) => row.text)[1]).toBe("P1.R1  ccccccc1  prompt  ✓");
	});
});
