import { beforeEach, describe, expect, it } from "vitest";
import { buildThreads } from "../src/threads.ts";
import {
	assistant,
	custom,
	jobNotice,
	resetIds,
	sessionMessage,
	toolResult,
	user,
	workerResult,
} from "./helpers.ts";

beforeEach(() => resetIds());

describe("buildThreads", () => {
	it("groups prompt -> reply 1 -> job -> reply 2 -> worker -> reply 3 under one prompt", () => {
		const threads = buildThreads([
			user("buscá si existe algo así"),
			assistant("Voy a mirar.", { toolCall: true }),
			toolResult("ok"),
			assistant("Encontré dos opciones. ¿Cuál preferís?", { id: "a1b2c3d4" }),
			jobNotice("job-1", "tests"),
			assistant("Tests en verde.", { id: "e5f6a7b8" }),
			workerResult("gentle-ai-worker", "mvlp-1", "docs"),
			assistant("Docs listas.", { id: "c9d0e1f2" }),
		]);

		expect(threads).toHaveLength(1);
		const [thread] = threads;
		expect(thread.prompt).toBe(1);
		expect(thread.promptText).toBe("buscá si existe algo así");
		expect(thread.replies.map((reply) => [reply.ordinal, reply.entryId, reply.text])).toEqual([
			["P1.R1", "a1b2c3d4", "Encontré dos opciones. ¿Cuál preferís?"],
			["P1.R2", "e5f6a7b8", "Tests en verde."],
			["P1.R3", "c9d0e1f2", "Docs listas."],
		]);
		expect(thread.replies.map((reply) => reply.triggers)).toEqual([
			[{ kind: "prompt", label: "prompt" }],
			[{ kind: "job", label: "tests" }],
			[{ kind: "worker", label: "docs" }],
		]);
	});

	it("numbers prompts in order and keeps each reply under the prompt that preceded it", () => {
		const threads = buildThreads([
			user("primero"),
			assistant("uno"),
			user("segundo"),
			assistant("dos"),
			assistant("dos bis"),
		]);

		expect(threads.map((thread) => [thread.prompt, thread.replies.map((reply) => reply.ordinal)])).toEqual([
			[1, ["P1.R1"]],
			[2, ["P2.R1", "P2.R2"]],
		]);
	});

	it("keeps a prompt with no reply yet as an empty thread", () => {
		const threads = buildThreads([user("hola")]);
		expect(threads).toHaveLength(1);
		expect(threads[0].replies).toEqual([]);
	});

	it("counts only finished assistant messages with text as replies", () => {
		const threads = buildThreads([
			user("hacelo"),
			assistant("narración intermedia", { toolCall: true }),
			toolResult("ok"),
			assistant("", { stopReason: "stop" }),
			assistant("cortado a mitad", { stopReason: "aborted" }),
			assistant("falló", { stopReason: "error" }),
			assistant("respuesta larga truncada", { stopReason: "length" }),
			assistant("listo"),
		]);

		expect(threads[0].replies.map((reply) => reply.text)).toEqual(["respuesta larga truncada", "listo"]);
	});

	it("labels jobs, workers and session messages from their notice text", () => {
		const threads = buildThreads([
			user("arrancá"),
			jobNotice("job-2", "recreate ckan-dev with auth env"),
			workerResult("gentle-ai-explore", "mv-2", "map footer data sources"),
			sessionMessage("01a16b37-9f3c-71e4-86c1-8db778ca5b61"),
			assistant("Todo junto."),
		]);

		expect(threads[0].replies[0].triggers).toEqual([
			{ kind: "prompt", label: "prompt" },
			{ kind: "job", label: "recreate ckan-dev with auth env" },
			{ kind: "worker", label: "map footer data sources" },
			{ kind: "session", label: "01a16b37" },
		]);
	});

	it("labels monitor events, including timeouts, as monitors", () => {
		const threads = buildThreads([
			user("vigilá"),
			assistant("uno"),
			custom("gentle-jobs.notice", 'Monitor job-1 ("P0 step 2 power events") reported 1 new line:\nac=0'),
			custom(
				"gentle-jobs.notice",
				'Monitor job-2 ("sweep progress lines") reached its 1800s timeout after 22 events and was stopped.',
			),
			assistant("dos"),
		]);

		expect(threads[0].replies[1].triggers).toEqual([
			{ kind: "monitor", label: "P0 step 2 power events" },
			{ kind: "monitor", label: "sweep progress lines" },
		]);
	});

	it("ignores hidden custom messages and labels unknown visible ones by their type", () => {
		const threads = buildThreads([
			user("dale"),
			assistant("uno"),
			custom("gentle-todo-state", "{}", false),
			custom("some-extension.ping", "ping"),
			assistant("dos"),
		]);

		expect(threads[0].replies[1].triggers).toEqual([{ kind: "other", label: "some-extension.ping" }]);
	});

	it("marks a reply that nothing new triggered as a follow-up with no triggers", () => {
		const threads = buildThreads([user("dale"), assistant("uno"), assistant("sigo")]);
		expect(threads[0].replies[1].triggers).toEqual([]);
	});

	it("falls back to the job id or agent name when a notice has no label", () => {
		const threads = buildThreads([
			user("dale"),
			custom("gentle-jobs.notice", "Background job job-7 exited with code 1 after 3s."),
			custom("gentle-agents.result", "Subagent gentle-ai-verify (task mv-9) finished."),
			assistant("uno"),
		]);

		expect(threads[0].replies[0].triggers).toEqual([
			{ kind: "prompt", label: "prompt" },
			{ kind: "job", label: "job-7" },
			{ kind: "worker", label: "gentle-ai-verify" },
		]);
	});

	it("reads custom message content given as text blocks", () => {
		const threads = buildThreads([
			user("dale"),
			assistant("uno"),
			custom("gentle-jobs.notice", [{ type: "text", text: 'Background job job-3 ("build") exited with code 0.' }]),
			assistant("dos"),
		]);

		expect(threads[0].replies[1].triggers).toEqual([{ kind: "job", label: "build" }]);
	});

	it("keeps replies that come before the first prompt in a thread numbered 0", () => {
		const threads = buildThreads([jobNotice("job-1", "boot"), assistant("arranqué"), user("hola"), assistant("hola")]);

		expect(threads.map((thread) => [thread.prompt, thread.replies.map((reply) => reply.ordinal)])).toEqual([
			[0, ["P0.R1"]],
			[1, ["P1.R1"]],
		]);
		expect(threads[0].replies[0].triggers).toEqual([{ kind: "job", label: "boot" }]);
	});

	it("records the timestamp of the prompt and of every reply", () => {
		const entries = [user("hola"), assistant("uno")];
		const [thread] = buildThreads(entries);
		expect(thread.timestamp).toBe(entries[0].timestamp);
		expect(thread.replies[0].timestamp).toBe(entries[1].timestamp);
	});
});
