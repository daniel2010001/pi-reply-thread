import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { indexRows } from "../src/format.ts";
import { findReply } from "../src/lookup.ts";
import { buildAsks, openIds, questionIds } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { askEntry, assistant, customEntry, resetIds, toolCalls, toolResultOf, user, wake } from "./helpers.ts";

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
			{ text: "¿Borro la rama vieja?", answer: "Sí, adelante", tool: "ask_user_question", options: ["Sí, adelante", "No"] },
			{ text: "¿Qué docs actualizo?", answer: "README, CHANGELOG", tool: "ask_user_question", options: ["README", "CHANGELOG"] },
			{ text: "¿Qué voz uso?", answer: "la de siempre", tool: "ask_user_question", options: ["Piper", "Otra"] },
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
			{
				text: "¿Dónde versiono la config?",
				answer: "Versioned in compose (recommended)",
				tool: "ask_user_choice",
				options: ["Versioned in compose (recommended)", "Aparte"],
			},
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
		expect(thread.replies[0].pauses).toEqual([
			{
				text: "¿Dónde versiono la config?",
				answer: "User cancelled the selection.",
				tool: "ask_user_choice",
				options: ["Versioned in compose (recommended)", "Aparte"],
			},
		]);
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

const pauseEntry = (data: unknown) => customEntry("reply-thread.pause", data);

describe("pauses: other dialogs while a tool runs (reply-thread.pause)", () => {
	it("closes a dialog with ran when its tool succeeded, after the ask-tool pauses in branch order", () => {
		const [thread] = buildThreads([
			user("arrancá"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "git push origin main" } }]),
			pauseEntry({ toolCallId: "call-b", toolName: "bash", kind: "confirm", title: "  Allow git push?  ", program: "git" }),
			toolResultOf("call-b", "bash", "Everything up-to-date"),
			assistant("Listo. ¿Algo más?", { id: "ddddddd1" }),
		]);
		const [reply] = thread.replies;
		expect(reply.ordinal).toBe("P1.R1");
		expect(reply.openAsks).toEqual(["Listo. ¿Algo más?"]);
		expect(reply.pauses).toEqual([
			{
				text: "¿Dónde versiono la config?",
				answer: "Versioned in compose (recommended)",
				tool: "ask_user_choice",
				options: ["Versioned in compose (recommended)", "Aparte"],
			},
			{ text: "Allow git push? [bash: git]", answer: "ran", tool: "bash", program: "git" },
		]);
		expect(questionIds(reply).map((one) => one.ordinal)).toEqual(["P1.R1.Q1", "P1.R1.Q2", "P1.R1.Q3"]);
	});

	it("closes a dialog with stopped and the first non-empty line of a failed result; no title gives <kind> dialog", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([{ id: "call-e", name: "rdd_review", arguments: {} }]),
			pauseEntry({ toolCallId: "call-e", toolName: "rdd_review", kind: "custom", title: "   " }),
			toolResultOf("call-e", "rdd_review", "\n  Blocked by the user.  \nmore", { isError: true }),
			assistant("Ok, no reviso."),
		]);
		expect(thread.replies[0].pauses).toEqual([
			{ text: "custom dialog [rdd_review]", answer: "stopped: Blocked by the user.", tool: "rdd_review" },
		]);
		expect(Object.keys(thread.replies[0].pauses[0])).toEqual(["text", "answer", "tool"]);
	});

	it("keeps several dialogs of one tool, in order", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "make deploy" } }]),
			pauseEntry({ toolCallId: "call-b", toolName: "bash", kind: "confirm", title: "First?", program: "make" }),
			pauseEntry({ toolCallId: "call-b", toolName: "bash", kind: "select", title: "Second?", program: "make" }),
			toolResultOf("call-b", "bash", "done"),
			assistant("Desplegado."),
		]);
		expect(thread.replies[0].pauses).toEqual([
			{ text: "First? [bash: make]", answer: "ran", tool: "bash", program: "make" },
			{ text: "Second? [bash: make]", answer: "ran", tool: "bash", program: "make" },
		]);
	});

	it("ignores an entry with an invalid shape", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "ls" } }]),
			pauseEntry({ toolName: "bash", kind: "confirm", title: "No id" }),
			pauseEntry({ toolCallId: "call-b", kind: "confirm", title: "No tool" }),
			pauseEntry({ toolCallId: "call-b", toolName: "bash", title: "No kind" }),
			pauseEntry({ toolCallId: "call-b", toolName: "bash", kind: "confirm", title: 7 }),
			pauseEntry({ toolCallId: "call-b", toolName: "bash", kind: "confirm", program: ["ls"] }),
			pauseEntry("call-b"),
			pauseEntry(null),
			toolResultOf("call-b", "bash", "README.md"),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses).toEqual([]);
	});

	it("drops a dialog no reply followed when a new prompt starts", () => {
		const threads = buildThreads([
			user("uno"),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "ls" } }]),
			pauseEntry({ toolCallId: "call-b", toolName: "bash", kind: "confirm", title: "Run?", program: "ls" }),
			toolResultOf("call-b", "bash", "README.md"),
			user("dos"),
			assistant("Ok."),
			toolCalls([{ id: "call-d", name: "bash", arguments: { command: "ls" } }]),
			pauseEntry({ toolCallId: "call-d", toolName: "bash", kind: "confirm", title: "Open?", program: "ls" }),
			user("tres"),
			toolResultOf("call-d", "bash", "README.md"),
			assistant("Ok."),
		]);
		expect(threads.map((thread) => thread.replies.map((reply) => reply.pauses))).toEqual([[], [[]], [[]]]);
	});

	it("leaves a branch without pause entries as before: reply IDs and asks", () => {
		const threads = buildThreads([
			user("uno"),
			assistant("Encontré dos. ¿Cuál preferís?", { id: "eeeeeee1" }),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "ls" } }]),
			toolResultOf("call-b", "bash", "README.md", { isError: true }),
			assistant("Listo.", { id: "eeeeeee2" }),
			user("dos"),
			assistant("¿Pusheo?", { id: "eeeeeee3" }),
		]);
		expect(
			threads.map((thread) => thread.replies.map((reply) => [reply.ordinal, reply.entryId, reply.openAsks, reply.pauses])),
		).toEqual([
			[
				["P1.R1", "eeeeeee1", ["Encontré dos. ¿Cuál preferís?"], []],
				["P1.R2", "eeeeeee2", [], []],
			],
			[["P2.R1", "eeeeeee3", ["¿Pusheo?"], []]],
		]);
	});
});

describe("pauses: tool and options for the pause card", () => {
	it("keeps no options key when an ask_user_question question or an ask_user_choice call has none", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([
				{ id: "call-q", name: "ask_user_question", arguments: { questions: [{ header: "Name", question: "¿Cómo se llama?" }] } },
				{ id: "call-c", name: "ask_user_choice", arguments: { question: "¿Cuál?", options: [] } },
			]),
			toolResultOf("call-q", "ask_user_question", "1. ¿Cómo se llama? — (custom) reply-thread"),
			toolResultOf("call-c", "ask_user_choice", "User selected: 1. Uno (value: 1)"),
			assistant("Listo."),
		]);
		const [question, choice] = thread.replies[0].pauses;
		expect(question).toEqual({ text: "¿Cómo se llama?", answer: "(custom) reply-thread", tool: "ask_user_question" });
		expect(choice).toEqual({ text: "¿Cuál?", answer: "Uno", tool: "ask_user_choice" });
		expect("options" in question).toBe(false);
		expect("options" in choice).toBe(false);
	});

	it("keeps option labels in order, skipping items without a text label", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([
				{
					id: "call-c",
					name: "ask_user_choice",
					arguments: { question: "¿Cuál?", options: [{ label: "B", value: "b" }, { value: "x" }, { label: "A", value: "a" }] },
				},
			]),
			toolResultOf("call-c", "ask_user_choice", "User selected: 2. A (value: a)"),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses[0].options).toEqual(["B", "A"]);
	});
});

describe("pauses: one line per question and answer", () => {
	it("joins the lines of a typed answer and of a question, so each row stays one line", () => {
		const ask = { questions: [{ header: "Notes", question: "¿Qué cambio?\n  Detalle abajo", options: [{ label: "Nada" }] }] };
		const [thread] = buildThreads([
			user("x"),
			toolCalls([{ id: "call-q", name: "ask_user_question", arguments: ask }]),
			toolResultOf("call-q", "ask_user_question", "1. ¿Qué cambio? — (custom) uno", {
				details: { answers: [{ questionIndex: 0, kind: "custom", answer: "uno\n\n  dos\r\ntres" }] },
			}),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses.map((pause) => [pause.text, pause.answer])).toEqual([["¿Qué cambio? Detalle abajo", "uno dos tres"]]);
	});
});

describe("pauses: a dialog title with several lines", () => {
	it("keeps only the title's first line: a guard puts the whole command on the next one", async () => {
		const { customEntry } = await import("./helpers.ts");
		const [thread] = buildThreads([
			user("borrá la carpeta"),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "rm -rf /tmp/x" } }]),
			customEntry("reply-thread.pause", {
				toolCallId: "call-b",
				toolName: "bash",
				kind: "select",
				title: "Allow recognized data-loss command?\nrm -rf /tmp/x",
				program: "rm",
			}),
			toolResultOf("call-b", "bash", ""),
			assistant("Borrada."),
		]);
		expect(thread.replies[0].pauses).toEqual([
			{ text: "Allow recognized data-loss command? [bash: rm]", answer: "ran", tool: "bash", program: "rm" },
		]);
	});
});

describe("pauses: the context the ask call came with", () => {
	it("keeps the text of the message that called the ask tool, trimmed, as the pause context", () => {
		const [thread] = buildThreads([
			user("config"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }], "\n  Revisé la config.\nHay dos sitios posibles.  \n"),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			assistant("Listo.", { id: "fffffff1" }),
		]);
		const [reply] = thread.replies;
		expect(reply.pauses).toEqual([
			{
				text: "¿Dónde versiono la config?",
				answer: "Versioned in compose (recommended)",
				tool: "ask_user_choice",
				options: ["Versioned in compose (recommended)", "Aparte"],
				context: "Revisé la config.\nHay dos sitios posibles.",
			},
		]);
		expect(reply.text).toBe("Listo.");
		expect(reply.openAsks).toEqual([]);
		expect(questionIds(reply)).toEqual([{ ordinal: "P1.R1.Q1", id: "fffffff1.1", text: "¿Dónde versiono la config?" }]);
	});

	it("has no context key when the message that called the ask tool has no text or only blank text", () => {
		const [thread] = buildThreads([
			user("config"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			toolCalls([{ id: "call-d", name: "ask_user_choice", arguments: CHOICE }], "  \n "),
			toolResultOf("call-d", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses).toHaveLength(2);
		for (const pause of thread.replies[0].pauses) expect("context" in pause).toBe(false);
	});

	it("shares the context between the questions and the ask calls of one message, joining its text blocks with a blank line", () => {
		const message = toolCalls(
			[
				{ id: "call-q", name: "ask_user_question", arguments: QUESTIONS },
				{ id: "call-c", name: "ask_user_choice", arguments: CHOICE },
			],
			"Encontré tres ramas viejas.",
		) as SessionEntry & { message: { content: unknown[] } };
		message.message.content.unshift({ type: "thinking", thinking: "no se muestra" });
		message.message.content.splice(2, 0, { type: "text", text: "  Y la config está suelta.  " });
		const [thread] = buildThreads([
			user("limpiá"),
			message,
			toolResultOf("call-q", "ask_user_question", QUESTIONS_TEXT, { details: QUESTIONS_DETAILS }),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses.map((pause) => pause.context)).toEqual(
			Array(4).fill("Encontré tres ramas viejas.\n\nY la config está suelta."),
		);
	});

	it("takes the context only from the message that carries the call", () => {
		const [thread] = buildThreads([
			user("x"),
			toolCalls([{ id: "call-c", name: "ask_user_choice", arguments: CHOICE }], "Primero esto."),
			toolResultOf("call-c", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			toolCalls([{ id: "call-d", name: "ask_user_choice", arguments: CHOICE }]),
			toolResultOf("call-d", "ask_user_choice", CHOICE_TEXT, { details: CHOICE_DETAILS }),
			assistant("Listo."),
		]);
		expect(thread.replies[0].pauses.map((pause) => pause.context)).toEqual(["Primero esto.", undefined]);
	});

	it("gives dialog pauses no context, even when the tool's message has text", () => {
		const [thread] = buildThreads([
			user("borrá"),
			toolCalls([{ id: "call-b", name: "bash", arguments: { command: "rm -rf /tmp/x" } }], "Borro la carpeta temporal."),
			customEntry("reply-thread.pause", { toolCallId: "call-b", toolName: "bash", kind: "confirm", title: "Allow?", program: "rm" }),
			toolResultOf("call-b", "bash", ""),
			assistant("Borrada."),
		]);
		expect(thread.replies[0].pauses).toEqual([{ text: "Allow? [bash: rm]", answer: "ran", tool: "bash", program: "rm" }]);
	});
});
