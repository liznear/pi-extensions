import {
	createWebReviewServer,
	getGitDiff,
	resolveGitTarget,
	type WebReviewServer,
	type WebReviewServerOptions,
} from "./web-review.js";

export interface StartReviewSessionInput {
	cwd: string;
	targetLabel: string;
	port?: number;
	onSubmit?: WebReviewServerOptions["onSubmit"];
	existingServer?: WebReviewServer | null;
}

export type StartReviewSessionResult =
	| {
		ok: true;
		targetLabel: string;
		resolvedTarget: string;
		diffOutput: string;
		server: WebReviewServer;
	}
	| {
		ok: false;
		targetLabel: string;
		reason: "invalid-target" | "no-diff";
	};

export async function startReviewSession(input: StartReviewSessionInput): Promise<StartReviewSessionResult> {
	const targetLabel = input.targetLabel.trim() || "HEAD";
	const resolvedTarget = await resolveGitTarget(input.cwd, targetLabel);

	if (!resolvedTarget) {
		return { ok: false, targetLabel, reason: "invalid-target" };
	}

	const diffOutput = await getGitDiff(input.cwd, resolvedTarget);
	if (!diffOutput.trim()) {
		return { ok: false, targetLabel, reason: "no-diff" };
	}

	if (input.existingServer) {
		await input.existingServer.close();
	}

	const server = await createWebReviewServer({
		cwd: input.cwd,
		target: resolvedTarget,
		targetLabel,
		port: input.port,
		onSubmit: input.onSubmit,
	});

	return {
		ok: true,
		targetLabel,
		resolvedTarget,
		diffOutput,
		server,
	};
}
