import { startReviewSession } from "./review-orchestration.js";

function parseArgs(argv: string[]): { cwd: string; target: string; port: number } {
	let cwd = process.cwd();
	let target = "HEAD";
	let port = 18765;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--cwd") {
			cwd = argv[++i] || cwd;
		} else if (arg === "--target") {
			target = argv[++i] || target;
		} else if (arg === "--port") {
			port = Number(argv[++i]) || port;
		} else if (arg && !arg.startsWith("-")) {
			target = arg;
		}
	}

	return { cwd, target, port };
}

const { cwd, target, port } = parseArgs(process.argv.slice(2));
const result = await startReviewSession({
	cwd,
	targetLabel: target,
	port,
	onSubmit: (comments) => {
		console.log(JSON.stringify(comments, null, 2));
	},
});

if (!result.ok) {
	if (result.reason === "invalid-target") {
		console.error(`Invalid git target: ${result.targetLabel}`);
		process.exit(1);
	}

	console.error("No local changes to review.");
	process.exit(1);
}

const review = result.server;
console.log(`Pi web review test server: ${review.url}`);
console.log(`cwd: ${cwd}`);
console.log(`target: ${result.targetLabel} (resolved: ${result.resolvedTarget})`);
console.log("Press Ctrl+C to stop.");
