import type { IncomingMessage, ServerResponse } from "node:http";
import { getGitDiff, loadGapContext } from "./diff-source.js";
import {
	REVIEW_ROUTES,
	createContextResponse,
	createSubmitErrorResponse,
	createSubmitResponse,
	parseContextRequest,
	parseSubmitRequestBody,
} from "./review-protocol.js";
import { renderReviewPage } from "./review-page.js";
import type { WebReviewServerOptions } from "./web-review-types.js";

const DEFAULT_TARGET = "HEAD";

export async function handleReviewRequest(req: IncomingMessage, res: ServerResponse, options: WebReviewServerOptions): Promise<void> {
	applyCors(res);

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	const url = new URL(req.url || "/", "http://localhost");

	if (url.pathname === REVIEW_ROUTES.root && req.method === "GET") {
		await handleRootRequest(res, options);
		return;
	}

	if (url.pathname === REVIEW_ROUTES.context && req.method === "GET") {
		try {
			await handleContextRequest(res, options, url);
		} catch (err) {
			sendJson(res, { error: getErrorMessage(err, "Invalid context request") }, 400);
		}
		return;
	}

	if (url.pathname === REVIEW_ROUTES.submit && req.method === "POST") {
		try {
			await handleSubmitRequest(req, res, options);
		} catch (err) {
			sendJson(res, createSubmitErrorResponse(getErrorMessage(err, "Invalid request")), 400);
		}
		return;
	}

	if (url.pathname === REVIEW_ROUTES.close && req.method === "POST") {
		handleCloseRequest(res);
		return;
	}

	sendNotFound(res);
}

async function handleRootRequest(res: ServerResponse, options: WebReviewServerOptions): Promise<void> {
	const target = resolveTarget(options);
	const diff = await getGitDiff(options.cwd, target);
	sendHtml(res, renderReviewPage({
		diff,
		target,
		targetLabel: options.targetLabel || target,
		cwd: options.cwd,
		submitEnabled: Boolean(options.onSubmit),
	}));
}

async function handleContextRequest(res: ServerResponse, options: WebReviewServerOptions, url: URL): Promise<void> {
	const contextRequest = parseContextRequest(url.searchParams);
	const rows = await loadGapContext({
		cwd: options.cwd,
		target: resolveTarget(options),
		file: contextRequest.file,
		oldStart: contextRequest.oldStart,
		oldEnd: contextRequest.oldEnd,
		newStart: contextRequest.newStart,
		newEnd: contextRequest.newEnd,
	});
	sendJson(res, createContextResponse(rows));
}

async function handleSubmitRequest(req: IncomingMessage, res: ServerResponse, options: WebReviewServerOptions): Promise<void> {
	const comments = parseSubmitRequestBody(await readRequestBody(req));
	if (options.onSubmit) await options.onSubmit(comments);
	sendJson(res, createSubmitResponse(comments));
}

function handleCloseRequest(res: ServerResponse): void {
	sendJson(res, { success: true });
}

function sendHtml(res: ServerResponse, html: string, status = 200): void {
	res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(payload));
}

function resolveTarget(options: WebReviewServerOptions): string {
	return options.target || DEFAULT_TARGET;
}

function applyCors(res: ServerResponse): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendNotFound(res: ServerResponse): void {
	res.writeHead(404);
	res.end("Not found");
}

function getErrorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
			if (body.length > 1024 * 1024) {
				reject(new Error("Request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

