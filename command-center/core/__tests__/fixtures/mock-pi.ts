// @ts-nocheck — mock pi for PiRPCSessionRunner tests. Speaks the JSONL RPC
// contract on stdin/stdout: answers get_state, and on each `prompt` emits a
// representative event stream then `agent_settled`. Behavior modes (argv[3]):
//   - "normal"      : emit text delta + a tool round-trip + message_end + agent_end, settle
//   - "crash"       : respond success then exit(1) BEFORE agent_settled (mid-turn death)
//   - "reject"      : respond success:false to the prompt
//   - "retry-fail"  : emit auto_retry_end{success:false} then agent_settled
// argv: <sessionId> <mode>
import process from "node:process"

const sessionId = process.argv[2] ?? "mock-session"
const mode = process.argv[3] ?? "normal"

let buf = ""
function send(obj: unknown) {
	process.stdout.write(`${JSON.stringify(obj)}\n`)
}
function respond(cmd: string, id: number | undefined, extra: object = {}) {
	send({ type: "response", command: cmd, success: true, id, data: extra })
}
function event(e: object) {
	send(e)
}

process.stdin.on("data", (chunk: Buffer) => {
	buf += chunk.toString("utf8")
	for (;;) {
		const i = buf.indexOf("\n")
		if (i < 0) break
		const line = buf.slice(0, i)
		buf = buf.slice(i + 1)
		handle(line)
	}
})

function handle(line: string) {
	let cmd: { type?: string; id?: number; message?: string }
	try {
		cmd = JSON.parse(line)
	} catch {
		return
	}
	if (cmd.type === "get_state") {
		respond("get_state", cmd.id, {
			sessionId,
			isStreaming: false,
			sessionFile: "",
		})
		return
	}
	if (cmd.type === "prompt") {
		if (mode === "reject") {
			send({
				type: "response",
				command: "prompt",
				success: false,
				id: cmd.id,
				error: "rejected",
			})
			return
		}
		// accepted
		respond("prompt", cmd.id)
		if (mode === "crash") {
			// die mid-turn, before any settle
			process.exit(1)
		}
		event({ type: "agent_start" })
		event({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				delta: "hello",
				contentIndex: 0,
			},
		})
		event({
			type: "tool_execution_start",
			toolCallId: "tc1",
			toolName: "report_status",
			args: { summary: "working" },
		})
		event({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "report_status",
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		})
		event({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: "mock",
				model: "m",
				usage: {},
				stopReason: "stop",
				timestamp: 0,
			},
		})
		event({ type: "agent_end", messages: [], willRetry: false })
		if (mode === "retry-fail") {
			event({
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "overloaded",
			})
		}
		event({ type: "agent_settled" })
		return
	}
	// best-effort ack for anything else
	if (cmd.type && cmd.id !== undefined) {
		respond(cmd.type, cmd.id)
	}
}
