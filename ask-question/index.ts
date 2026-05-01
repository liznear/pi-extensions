/**
 * Ask User Extension - Tools for LLM to ask the user questions
 *
 * Provides two tools:
 * 1. ask_user - Ask a single question with optional choices
 * 2. ask_questions - Ask multiple questions in a tabbed interface
 *
 * Use these when you need user input on preferences, design decisions,
 * clarifications, or confirmations.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ============================================================
// Types
// ============================================================

interface QuestionOption {
	label: string;
	description?: string;
}

interface Question {
	id: string;
	question: string;
	options?: QuestionOption[];
	allowCustom?: boolean;
}

interface Answer {
	questionId: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
}

interface AskUserDetails {
	question: string;
	options?: string[];
	answer: string | null;
	wasCustom?: boolean;
	optionIndex?: number;
	cancelled: boolean;
}

interface AskQuestionsDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// ============================================================
// Schemas
// ============================================================

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const AskUserParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Optional list of choices" })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow user to type custom answer (default: true)" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	question: Type.String({ description: "The question text" }),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Optional choices" })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow custom answer (default: true)" })),
});

const AskQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask" }),
});

// ============================================================
// Helper: Single Question UI
// ============================================================

async function askSingleQuestion(
	ctx: ExtensionContext,
	question: string,
	options: QuestionOption[],
	allowCustom: boolean,
): Promise<{ answer: string; wasCustom: boolean; optionIndex?: number } | null> {

	const allOptions: (QuestionOption & { isOther?: boolean })[] = [...options];
	if (allowCustom) {
		allOptions.push({ label: "Type something...", isOther: true });
	}

	return ctx.ui.custom<{ answer: string; wasCustom: boolean; optionIndex?: number } | null>(
		(tui, theme, _kb, done) => {
			let optionIndex = 0;
			let editMode = false;
			let cachedLines: string[] | undefined;

			const editorTheme: EditorTheme = {
				borderColor: (s) => theme.fg("accent", s),
			};
			const editor = new Editor(tui, editorTheme);

			editor.onSubmit = (value) => {
				const trimmed = value.trim();
				if (trimmed) {
					done({ answer: trimmed, wasCustom: true });
				} else {
					editMode = false;
					editor.setText("");
					refresh();
				}
			};

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function handleInput(data: string) {
				if (editMode) {
					if (matchesKey(data, Key.escape)) {
						editMode = false;
						editor.setText("");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
					refresh();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					const selected = allOptions[optionIndex];
					if (selected.isOther) {
						editMode = true;
						refresh();
					} else {
						done({ answer: selected.label, wasCustom: false, optionIndex });
					}
					return;
				}

				if (matchesKey(data, Key.escape)) {
					done(null);
				}
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const lines: string[] = [];
				const add = (s: string) => lines.push(truncateToWidth(s, width));

				add(theme.fg("accent", "─".repeat(width)));
				add(theme.fg("text", ` ${question}`));
				lines.push("");

				for (let i = 0; i < allOptions.length; i++) {
					const opt = allOptions[i];
					const selected = i === optionIndex;
					const isOther = opt.isOther === true;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";

					if (isOther && editMode) {
						add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
					} else if (selected) {
						add(prefix + theme.fg("accent", `${i + 1}. ${opt.label}`));
					} else {
						add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}`);
					}

					if (opt.description) {
						add(`     ${theme.fg("muted", opt.description)}`);
					}
				}

				if (editMode) {
					lines.push("");
					add(theme.fg("muted", " Your answer:"));
					for (const line of editor.render(width - 2)) {
						add(` ${line}`);
					}
				}

				lines.push("");
				if (editMode) {
					add(theme.fg("dim", " Enter to submit • Esc to go back"));
				} else {
					add(theme.fg("dim", " ↑↓ navigate • Enter to select • Esc to cancel"));
				}
				add(theme.fg("accent", "─".repeat(width)));

				cachedLines = lines;
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
				},
				handleInput,
			};
		},
	);
}

// ============================================================
// Helper: Multiple Questions UI (Tabbed)
// ============================================================

async function askMultipleQuestions(
	ctx: ExtensionContext,
	questions: Question[],
): Promise<{ answers: Answer[]; cancelled: boolean }> {

	const totalTabs = questions.length + 1; // questions + Submit

	return ctx.ui.custom<{ answers: Answer[]; cancelled: boolean }>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			done({ answers: Array.from(answers.values()), cancelled });
		}

		function currentQuestion(): Question | undefined {
			return questions[currentTab];
		}

		function currentOptions(): (QuestionOption & { isOther?: boolean })[] {
			const q = currentQuestion();
			if (!q) return [];
			const opts: (QuestionOption & { isOther?: boolean })[] = [...(q.options || [])];
			if (q.allowCustom !== false) {
				opts.push({ label: "Type something...", isOther: true });
			}
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function advanceAfterAnswer() {
			if (currentTab < questions.length - 1) {
				currentTab++;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			refresh();
		}

		function saveAnswer(questionId: string, answer: string, wasCustom: boolean, optionIndex?: number) {
			answers.set(questionId, { questionId, answer, wasCustom, optionIndex });
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim() || "(no response)";
			saveAnswer(inputQuestionId, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Tab navigation
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				currentTab = (currentTab + 1) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}

			// Submit tab
			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					submit(false);
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			// Option navigation
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(currentOptions().length - 1, optionIndex + 1);
				refresh();
				return;
			}

			// Select option
			if (matchesKey(data, Key.enter)) {
				const q = currentQuestion();
				const opts = currentOptions();
				const opt = opts[optionIndex];
				if (opt.isOther) {
					inputMode = true;
					inputQuestionId = q!.id;
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(q!.id, opt.label, false, optionIndex);
				advanceAfterAnswer();
				return;
			}

			// Cancel
			if (matchesKey(data, Key.escape)) {
				submit(true);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));
			const q = currentQuestion();
			const opts = currentOptions();

			add(theme.fg("accent", "─".repeat(width)));

			// Tab bar
			const tabs: string[] = ["← "];
			for (let i = 0; i < questions.length; i++) {
				const isActive = i === currentTab;
				const isAnswered = answers.has(questions[i].id);
				const lbl = questions[i].id;
				const box = isAnswered ? "■" : "□";
				const color = isAnswered ? "success" : "muted";
				const text = ` ${box} ${lbl} `;
				const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
				tabs.push(`${styled} `);
			}
			const canSubmit = allAnswered();
			const isSubmitTab = currentTab === questions.length;
			const submitText = " ✓ Submit ";
			const submitStyled = isSubmitTab
				? theme.bg("selectedBg", theme.fg("text", submitText))
				: theme.fg(canSubmit ? "success" : "dim", submitText);
			tabs.push(`${submitStyled} →`);
			add(` ${tabs.join("")}`);
			lines.push("");

			// Content
			if (inputMode && q) {
				add(theme.fg("text", ` ${q.question}`));
				lines.push("");
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					if (opt.isOther && inputMode) {
						add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
					} else {
						add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`));
					}
					if (opt.description) {
						add(`     ${theme.fg("muted", opt.description)}`);
					}
				}
				lines.push("");
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(width - 2)) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (answer) {
						const prefix = answer.wasCustom ? "(wrote) " : "";
						add(`${theme.fg("muted", ` ${question.id}: `)}${theme.fg("text", prefix + answer.answer)}`);
					}
				}
				lines.push("");
				if (allAnswered()) {
					add(theme.fg("success", " Press Enter to submit"));
				} else {
					const missing = questions
						.filter((q) => !answers.has(q.id))
						.map((q) => q.id)
						.join(", ");
					add(theme.fg("warning", ` Unanswered: ${missing}`));
				}
			} else if (q) {
				add(theme.fg("text", ` ${q.question}`));
				lines.push("");
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`));
					if (opt.description) {
						add(`     ${theme.fg("muted", opt.description)}`);
					}
				}
			}

			lines.push("");
			if (!inputMode) {
				add(theme.fg("dim", " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"));
			}
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

// ============================================================
// Extension
// ============================================================

export default function askUser(pi: ExtensionAPI) {
	// Tool: ask_user - Ask a single question
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question and wait for their response. Use this when you need user input on preferences, design decisions, or clarifications. Can provide options for the user to choose from, or let them type a custom answer.",
		parameters: AskUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						answer: null,
						cancelled: true,
					} as AskUserDetails,
				};
			}

			const options = params.options || [];
			const allowCustom = params.allowCustom !== false;

			// If no options and custom allowed, just prompt for input
			if (options.length === 0 && allowCustom) {
				const answer = await ctx.ui.input("Question", params.question);
				if (answer === null) {
					return {
						content: [{ type: "text", text: "User cancelled" }],
						details: { question: params.question, answer: null, cancelled: true } as AskUserDetails,
					};
				}
				return {
					content: [{ type: "text", text: `User answered: ${answer}` }],
					details: { question: params.question, answer, wasCustom: true, cancelled: false } as AskUserDetails,
				};
			}

			// If no options and custom not allowed, that's an error
			if (options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided and custom input disabled" }],
					details: { question: params.question, answer: null, cancelled: true } as AskUserDetails,
				};
			}

			// Use custom UI for options
			const result = await askSingleQuestion(ctx, params.question, options, allowCustom);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question: params.question, answer: null, cancelled: true } as AskUserDetails,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: result.wasCustom
							? `User answered: ${result.answer}`
							: `User selected: ${result.optionIndex! + 1}. ${result.answer}`,
					},
				],
				details: {
					question: params.question,
					options: options.map((o) => o.label),
					answer: result.answer,
					wasCustom: result.wasCustom,
					optionIndex: result.optionIndex,
					cancelled: false,
				} as AskUserDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: QuestionOption) => o.label);
				text += `\n${theme.fg("dim", `  Options: ${labels.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);

			if (details.cancelled || details.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

			const prefix = details.wasCustom ? "(wrote) " : `#${(details.optionIndex ?? 0) + 1} `;
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", prefix) + theme.fg("accent", details.answer), 0, 0);
		},
	});

	// Tool: ask_questions - Ask multiple questions
	pi.registerTool({
		name: "ask_questions",
		label: "Ask Questions",
		description:
			"Ask the user multiple questions in a tabbed interface. Use this when you need answers to several related questions, like gathering requirements or confirming multiple design decisions.",
		parameters: AskQuestionsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { questions: params.questions, answers: [], cancelled: true } as AskQuestionsDetails,
				};
			}

			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { questions: [], answers: [], cancelled: true } as AskQuestionsDetails,
				};
			}

			// Single question: use simpler UI
			if (params.questions.length === 1) {
				const q = params.questions[0];
				const options = q.options || [];
				const allowCustom = q.allowCustom !== false;

				if (options.length === 0 && allowCustom) {
					const answer = await ctx.ui.input("Question", q.question);
					if (answer === null) {
						return {
							content: [{ type: "text", text: "User cancelled" }],
							details: {
								questions: params.questions,
								answers: [],
								cancelled: true,
							} as AskQuestionsDetails,
						};
					}
					return {
						content: [{ type: "text", text: `${q.id}: ${answer}` }],
						details: {
							questions: params.questions,
							answers: [{ questionId: q.id, answer, wasCustom: true }],
							cancelled: false,
						} as AskQuestionsDetails,
					};
				}

				const result = await askSingleQuestion(ctx, q.question, options, allowCustom);
				if (!result) {
					return {
						content: [{ type: "text", text: "User cancelled" }],
						details: { questions: params.questions, answers: [], cancelled: true } as AskQuestionsDetails,
					};
				}

				return {
					content: [{ type: "text", text: `${q.id}: ${result.answer}` }],
					details: {
						questions: params.questions,
						answers: [{ questionId: q.id, answer: result.answer, wasCustom: result.wasCustom }],
						cancelled: false,
					} as AskQuestionsDetails,
				};
			}

			// Multiple questions: use tabbed UI
			const result = await askMultipleQuestions(ctx, params.questions);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: { questions: params.questions, answers: result.answers, cancelled: true } as AskQuestionsDetails,
				};
			}

			const answerLines = result.answers.map((a) => `${a.questionId}: ${a.answer}`);
			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: { questions: params.questions, answers: result.answers, cancelled: false } as AskQuestionsDetails,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const ids = qs.map((q) => q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("ask_questions "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (ids) {
				text += theme.fg("dim", ` (${truncateToWidth(ids, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskQuestionsDetails | undefined;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);

			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

			const lines = details.answers.map((a) => 
				theme.fg("success", "✓ ") + theme.fg("accent", a.questionId) + ": " + 
				(a.wasCustom ? theme.fg("muted", "(wrote) ") : "") + a.answer
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
