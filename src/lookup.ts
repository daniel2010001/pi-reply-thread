import type { Reply, Thread } from "./threads.ts";

/** Finds a reply by ordered ID (`P12.R1`, any case) or by its exact Pi entry ID. */
export function findReply(threads: readonly Thread[], id: string): Reply | undefined {
	const wanted = id.trim();
	if (!wanted) return undefined;
	const ordinal = wanted.toLowerCase();
	for (const thread of threads) {
		for (const reply of thread.replies) {
			if (reply.entryId === wanted || reply.ordinal.toLowerCase() === ordinal) return reply;
		}
	}
	return undefined;
}

export function noMatchMessage(arg: string): string {
	return `No reply matches "${arg}". Run /replies to list them.`;
}
