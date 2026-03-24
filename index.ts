import { calculateCost, createAssistantMessageEventStream, getModels, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type SessionNotification, type SessionUpdate, type RequestPermissionRequest, type RequestPermissionResponse, type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest, type WriteTextFileResponse, type CreateTerminalRequest, type CreateTerminalResponse, type TerminalOutputRequest, type TerminalOutputResponse, type WaitForTerminalExitRequest, type WaitForTerminalExitResponse, type KillTerminalRequest, type KillTerminalResponse, type ReleaseTerminalRequest, type ReleaseTerminalResponse } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable, Readable } from "node:stream";

const PROVIDER_ID = "claude-code-acp";

const LATEST_MODEL_IDS = new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);

const MODELS = getModels("anthropic")
	.filter((model) => LATEST_MODEL_IDS.has(model.id))
	.map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));

// --- Prompt building ---

function buildPromptText(context: Context): string {
	const parts: string[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			const text = messageContentToText(message.content);
			parts.push(`USER:\n${text || "(see attached image)"}`);
			continue;
		}

		if (message.role === "assistant") {
			const text = assistantContentToText(message.content);
			if (text.length > 0) {
				parts.push(`ASSISTANT:\n${text}`);
			}
			continue;
		}

		if (message.role === "toolResult") {
			const header = `TOOL RESULT (historical ${message.toolName ?? "unknown"}):`;
			const text = messageContentToText(message.content);
			parts.push(`${header}\n${text || "(see attached image)"}`);
		}
	}

	return parts.join("\n\n") || "";
}

function messageContentToText(
	content:
		| string
		| Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const textParts: string[] = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
			hasText = true;
		} else if (block.type === "image") {
			// text-only for v1
		} else {
			textParts.push(`[${block.type}]`);
		}
	}
	return hasText ? textParts.join("\n") : "";
}

function assistantContentToText(
	content:
		| string
		| Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		}>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") {
				const args = block.arguments ? JSON.stringify(block.arguments) : "{}";
				return `Historical tool call (non-executable): ${block.name} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}

// --- ACP connection management ---

interface TerminalState {
	proc: ChildProcess;
	output: string;
	exitCode?: number | null;
	signal?: string | null;
}

let acpProcess: ChildProcess | null = null;
let acpConnection: ClientSideConnection | null = null;
let sessionUpdateHandler: ((update: SessionUpdate) => void) | null = null;
let activeSessionId: string | null = null;
let activeModelId: string | null = null;
let lastContextLength = 0;
let nextTerminalId = 1;
const terminals = new Map<string, TerminalState>();

function handleRequestPermission(params: RequestPermissionRequest): RequestPermissionResponse {
	const allowOption = params.options.find(
		(o) => o.kind === "allow_once" || o.kind === "allow_always",
	);
	if (allowOption) {
		return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
	}
	return { outcome: { outcome: "cancelled" } };
}

async function handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
	const content = await readFile(params.path, "utf-8");
	if (params.line != null || params.limit != null) {
		const lines = content.split("\n");
		const start = Math.max(0, (params.line ?? 1) - 1);
		const end = params.limit != null ? start + params.limit : lines.length;
		return { content: lines.slice(start, end).join("\n") };
	}
	return { content };
}

async function handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
	await mkdir(dirname(params.path), { recursive: true });
	await writeFile(params.path, params.content, "utf-8");
	return {};
}

function handleCreateTerminal(params: CreateTerminalRequest): CreateTerminalResponse {
	const id = `term-${nextTerminalId++}`;
	const args = params.args ?? [];
	const proc = spawn(params.command, args, {
		cwd: params.cwd ?? process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			...(params.env
				? Object.fromEntries(params.env.map((e) => [e.name, e.value]))
				: {}),
		},
	});

	const state: TerminalState = { proc, output: "" };
	terminals.set(id, state);

	proc.stdout?.on("data", (chunk: Buffer) => {
		state.output += chunk.toString();
		if (params.outputByteLimit && state.output.length > params.outputByteLimit) {
			state.output = state.output.slice(-params.outputByteLimit);
		}
	});
	proc.stderr?.on("data", (chunk: Buffer) => {
		state.output += chunk.toString();
		if (params.outputByteLimit && state.output.length > params.outputByteLimit) {
			state.output = state.output.slice(-params.outputByteLimit);
		}
	});
	proc.on("close", (code, signal) => {
		state.exitCode = code;
		state.signal = signal;
	});

	return { terminalId: id };
}

function handleTerminalOutput(params: TerminalOutputRequest): TerminalOutputResponse {
	const state = terminals.get(params.terminalId);
	if (!state) return { output: "", truncated: false };
	return {
		output: state.output,
		truncated: false,
		...(state.exitCode !== undefined || state.signal !== undefined
			? { exitStatus: { exitCode: state.exitCode, signal: state.signal } }
			: {}),
	};
}

async function handleWaitForTerminalExit(
	params: WaitForTerminalExitRequest,
): Promise<WaitForTerminalExitResponse> {
	const state = terminals.get(params.terminalId);
	if (!state) return { exitCode: 1 };
	return new Promise((resolve) => {
		state.proc.on("close", (code, signal) => {
			resolve({ exitCode: code, signal });
		});
		if (state.exitCode !== undefined || state.signal !== undefined) {
			resolve({ exitCode: state.exitCode, signal: state.signal });
		}
	});
}

function handleKillTerminal(params: KillTerminalRequest): KillTerminalResponse | void {
	const state = terminals.get(params.terminalId);
	if (state) state.proc.kill();
}

function handleReleaseTerminal(params: ReleaseTerminalRequest): ReleaseTerminalResponse | void {
	const state = terminals.get(params.terminalId);
	if (state) {
		state.proc.kill();
		terminals.delete(params.terminalId);
	}
}

function killConnection() {
	if (acpProcess) {
		acpProcess.kill();
		acpProcess = null;
	}
	for (const [, state] of terminals) {
		state.proc.kill();
	}
	terminals.clear();
	acpConnection = null;
	sessionUpdateHandler = null;
	activeSessionId = null;
	activeModelId = null;
	lastContextLength = 0;
	nextTerminalId = 1;
}

async function ensureConnection(): Promise<ClientSideConnection> {
	if (acpConnection) return acpConnection;

	const child = spawn("npx", ["-y", "@zed-industries/claude-agent-acp"], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	acpProcess = child;

	child.stderr?.on("data", () => {
		// Suppress stderr noise from npx/agent startup
	});

	child.on("close", () => {
		acpProcess = null;
		killConnection();
	});

	const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
	const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
	const rawStream = ndJsonStream(input, output);

	// Intercept session/update notifications before SDK validation
	// (same workaround as claude-acp.ts — avoids Zod union parse errors)
	const filter = new TransformStream({
		transform(msg: any, controller) {
			if ("method" in msg && msg.method === "session/update" && !("id" in msg) && msg.params) {
				try {
					const update = (msg.params as SessionNotification).update;
					sessionUpdateHandler?.(update);
				} catch (e) {
					console.error("[claude-code-acp] session/update handler error:", e);
				}
				return;
			}
			controller.enqueue(msg);
		},
	});
	rawStream.readable.pipeTo(filter.writable).catch(() => {});
	const stream = { readable: filter.readable, writable: rawStream.writable };

	const connection = new ClientSideConnection(
		() => ({
			sessionUpdate: async () => {}, // handled by stream filter above
			requestPermission: async (params) => handleRequestPermission(params),
			readTextFile: async (params) => handleReadTextFile(params),
			writeTextFile: async (params) => handleWriteTextFile(params),
			createTerminal: async (params) => handleCreateTerminal(params),
			terminalOutput: async (params) => handleTerminalOutput(params),
			waitForTerminalExit: async (params) => handleWaitForTerminalExit(params),
			killTerminal: async (params) => handleKillTerminal(params),
			releaseTerminal: async (params) => handleReleaseTerminal(params),
		}),
		stream,
	);

	await connection.initialize({
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: {
			fs: { readTextFile: true, writeTextFile: true },
			terminal: true,
		},
		clientInfo: { name: "pi-claude-code-acp", version: "0.1.0" },
	});

	acpConnection = connection;
	return connection;
}

// Clean up on process exit
process.on("exit", () => killConnection());
process.on("SIGTERM", () => killConnection());

// --- Core streaming function ---

function streamClaudeAcp(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const blocks = output.content as Array<
			| { type: "text"; text: string }
			| { type: "thinking"; thinking: string }
		>;

		let started = false;
		let textBlockIndex = -1;
		let thinkingBlockIndex = -1;
		let sessionId: string | null = null;

		const pushStart = () => {
			if (!started) {
				stream.push({ type: "start", partial: output });
				started = true;
			}
		};

		try {
			const connection = await ensureConnection();

			// TODO: consider prepending pi skills or other pi-specific context to
			// the first prompt. Claude Code loads its own CLAUDE.md so we don't
			// send that, but pi skills aren't visible to Claude Code.

			// Determine if we need a new session or can reuse
			let promptText: string;
			if (!activeSessionId) {
				// First call or session was lost — new session with full context
				const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
				sessionId = session.sessionId;
				activeSessionId = sessionId;
				await connection.setSessionMode({ sessionId, modeId: "bypassPermissions" });
				await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
				activeModelId = model.id;
				promptText = buildPromptText(context);
				lastContextLength = context.messages.length;
			} else {
				// Continuation — ACP already has prior context, just send latest user message
				sessionId = activeSessionId;
				if (activeModelId !== model.id) {
					await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
					activeModelId = model.id;
				}
				const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
				promptText = lastUser
					? messageContentToText(lastUser.content) || ""
					: "";
				lastContextLength = context.messages.length;
			}

			// Wire session update handler for this call
			sessionUpdateHandler = (update: SessionUpdate) => {
				pushStart();

				switch (update.sessionUpdate) {
					case "agent_message_chunk": {
						const content = update.content;
						if (content.type === "text" && "text" in content) {
							const text = (content as { text: string }).text;
							if (textBlockIndex === -1) {
								blocks.push({ type: "text", text: "" });
								textBlockIndex = blocks.length - 1;
								stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
							}
							const block = blocks[textBlockIndex] as { type: "text"; text: string };
							block.text += text;
							stream.push({
								type: "text_delta",
								contentIndex: textBlockIndex,
								delta: text,
								partial: output,
							});
						}
						break;
					}

					case "agent_thought_chunk": {
						const content = update.content;
						if (content.type === "text" && "text" in content) {
							const text = (content as { text: string }).text;
							if (thinkingBlockIndex === -1) {
								blocks.push({ type: "thinking", thinking: "" });
								thinkingBlockIndex = blocks.length - 1;
								stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
							}
							const block = blocks[thinkingBlockIndex] as { type: "thinking"; thinking: string };
							block.thinking += text;
							stream.push({
								type: "thinking_delta",
								contentIndex: thinkingBlockIndex,
								delta: text,
								partial: output,
							});
						}
						break;
					}

					case "tool_call":
					case "tool_call_update":
						// ACP executes tools internally — don't emit to pi
						break;

					case "usage_update": {
						const usage = update as { used?: number; size?: number; cost?: { total?: number } } & { sessionUpdate: string };
						if (usage.used != null) output.usage.totalTokens = usage.used;
						// ACP doesn't break down input/output/cache — put total in input
						if (usage.used != null) output.usage.input = usage.used;
						calculateCost(model, output.usage);
						break;
					}

					default:
						break;
				}
			};

			// Set up abort handling
			const onAbort = () => {
				if (sessionId && acpConnection) {
					acpConnection.cancel({ sessionId });
				}
			};
			if (options?.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}

			try {
				const result = await connection.prompt({
					sessionId,
					prompt: [{ type: "text", text: promptText }],
				});

				// Close any open blocks
				if (thinkingBlockIndex !== -1) {
					const thinkBlock = blocks[thinkingBlockIndex] as { type: "thinking"; thinking: string };
					stream.push({ type: "thinking_end", contentIndex: thinkingBlockIndex, content: thinkBlock.thinking, partial: output });
				}
				if (textBlockIndex !== -1) {
					const textBlock = blocks[textBlockIndex] as { type: "text"; text: string };
					stream.push({ type: "text_end", contentIndex: textBlockIndex, content: textBlock.text, partial: output });
				}

				if (options?.signal?.aborted) {
					output.stopReason = "aborted";
					output.errorMessage = "Operation aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
					stream.end();
					return;
				}

				output.stopReason = result.stopReason === "cancelled" ? "aborted" : "stop";
				pushStart();
				stream.push({
					type: "done",
					reason: "stop",
					message: output,
				});
				stream.end();
			} finally {
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				sessionUpdateHandler = null;
			}
		} catch (error) {
			// If connection failed, reset for retry on next call
			if (!acpConnection || acpProcess === null) {
				killConnection();
			}

			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			if (!started) stream.push({ type: "start", partial: output });
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();

	return stream;
}

// --- Provider registration ---

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-code-acp",
		apiKey: "not-used",
		api: "claude-code-acp",
		models: MODELS,
		streamSimple: streamClaudeAcp,
	});
}
