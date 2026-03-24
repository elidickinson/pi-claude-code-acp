import { calculateCost, createAssistantMessageEventStream, getModels, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type SessionNotification, type SessionUpdate, type PromptResponse } from "@agentclientprotocol/sdk";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";

const PROVIDER_ID = "claude-code-acp";
const MCP_SERVER_NAME = "pi-tools";

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

// --- Config ---

interface Config {
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		appendSkills?: boolean;  // default true — forward pi's skills to Claude Code
	};
}

function loadConfig(cwd: string): Config {
	const globalPath = join(homedir(), ".pi", "agent", "claude-code-acp.json");
	const projectPath = join(cwd, ".pi", "claude-code-acp.json");

	let global: Partial<Config> = {};
	let project: Partial<Config> = {};

	if (existsSync(globalPath)) {
		try { global = JSON.parse(readFileSync(globalPath, "utf-8")); } catch {}
	}
	if (existsSync(projectPath)) {
		try { project = JSON.parse(readFileSync(projectPath, "utf-8")); } catch {}
	}

	return {
		askClaude: { ...global.askClaude, ...project.askClaude },
	};
}

// --- AskClaude helpers ---

interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
	locations?: Array<{ path?: string; uri?: string }>;
}

function extractPath(rawInput: unknown): string | undefined {
	if (!rawInput || typeof rawInput !== "object") return undefined;
	const input = rawInput as Record<string, unknown>;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return input.command.substring(0, 80);
	return undefined;
}

function tcPath(tc: ToolCallState): string | undefined {
	const loc = tc.locations?.[0]?.path;
	return loc ?? extractPath(tc.rawInput);
}

function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const reads: string[] = [];
	const edits: string[] = [];
	const commands: string[] = [];
	const other: string[] = [];

	for (const [, tc] of calls) {
		const path = tcPath(tc);
		const name = tc.name.toLowerCase();
		if (name === "read" || name === "readfile") {
			if (path) reads.push(path);
		} else if (name === "edit" || name === "write" || name === "writefile" || name === "multiedit") {
			if (path) edits.push(path);
		} else if (name === "bash" || name === "terminal") {
			commands.push(path ?? "command");
		} else {
			other.push(tc.name + (path ? ` ${path}` : ""));
		}
	}

	const parts: string[] = [];
	if (reads.length) parts.push(`read ${reads.join(", ")}`);
	if (edits.length) parts.push(`edited ${edits.join(", ")}`);
	if (commands.length) parts.push(`ran ${commands.join("; ")}`);
	if (other.length) parts.push(other.join("; "));
	return parts.join("; ");
}

function extractSkillsBlock(systemPrompt: string): string | undefined {
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	return systemPrompt.slice(start, end + endMarker.length).trim();
}

const MODE_PRESETS: Record<string, Record<string, unknown>> = {
	full: {},
	read: { claudeCode: { options: { allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"] } } },
	none: { disableBuiltInTools: true },
};

// --- Provider helpers ---

function getToolsForMcp(tools?: Tool[]): Tool[] {
	return tools ?? [];
}

// --- Prompt building ---

function buildPromptText(context: Context): string {
	const parts: string[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			const text = messageContentToText(message.content);
			parts.push(`USER:\n${text || "(see attached image)"}`);
		} else if (message.role === "assistant") {
			const text = assistantContentToText(message.content);
			if (text.length > 0) {
				parts.push(`ASSISTANT:\n${text}`);
			}
		} else if (message.role === "toolResult") {
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
			// text-only for now
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
				return `Historical tool call: ${block.name} args=${args}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}

// --- HTTP bridge for MCP tool calls ---

interface PendingToolCall {
	toolName: string;
	args: Record<string, unknown>;
	resolve: (result: string) => void;
}

let bridgeServer: Server | null = null;
let bridgePort: number | null = null;
let pendingToolCall: PendingToolCall | null = null;
let toolCallDetected: (() => void) | null = null;

async function ensureBridgeServer(): Promise<number> {
	if (bridgeServer && bridgePort != null) return bridgePort;

	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}

			let body = "";
			req.on("data", (chunk: Buffer) => { body += chunk; });
			req.on("end", () => {
				try {
					const { toolName, args } = JSON.parse(body);
					pendingToolCall = {
						toolName,
						args: args ?? {},
						resolve: (result: string) => {
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify({ result }));
						},
					};
					toolCallDetected?.();
				} catch {
					res.writeHead(400);
					res.end("Bad request");
				}
			});
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			bridgeServer = server;
			bridgePort = addr.port;
			resolve(addr.port);
		});
	});
}

// --- MCP server script generation ---

let mcpServerScriptPath: string | null = null;

function generateMcpServerScript(tools: Tool[], bridgeUrl: string): string {
	const toolSchemas = tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.parameters,
	}));

	// Claude Code uses ndjson for MCP stdio, not Content-Length framing
	return `const http = require("http");
const BRIDGE_URL = ${JSON.stringify(bridgeUrl)};
const TOOLS = ${JSON.stringify(toolSchemas)};

const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try { handleMessage(JSON.parse(line)); } catch {}
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "pi-tools", version: "1.0.0" }
    }});
  } else if (msg.method === "notifications/initialized") {
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS }});
  } else if (msg.method === "tools/call") {
    const toolName = msg.params.name;
    const args = msg.params.arguments || {};
    const postData = JSON.stringify({ toolName, args });
    const url = new URL(BRIDGE_URL);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try {
          const { result } = JSON.parse(body);
          send({ jsonrpc: "2.0", id: msg.id, result: {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }]
          }});
        } catch (e) {
          send({ jsonrpc: "2.0", id: msg.id, result: {
            content: [{ type: "text", text: "Error: " + e.message }], isError: true
          }});
        }
      });
    });
    req.on("error", (e) => {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: "Bridge error: " + e.message }], isError: true
      }});
    });
    req.end(postData);
  }
}
`;
}

async function writeMcpServerScript(tools: Tool[], bridgeUrl: string): Promise<string> {
	const script = generateMcpServerScript(tools, bridgeUrl);
	const path = join(tmpdir(), `pi-tools-mcp-${process.pid}.js`);
	await writeFile(path, script, "utf-8");
	mcpServerScriptPath = path;
	return path;
}

// --- Tool result extraction ---

function extractLastToolResult(context: Context): { toolName: string; content: string } | null {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "toolResult") {
			return {
				toolName: msg.toolName,
				content: messageContentToText(msg.content),
			};
		}
	}
	return null;
}

// --- ACP connection management ---

let acpProcess: ChildProcess | null = null;
let acpConnection: ClientSideConnection | null = null;
let sessionUpdateHandler: ((update: SessionUpdate) => void) | null = null;
let activeSessionId: string | null = null;
let activeModelId: string | null = null;
let activePromise: Promise<PromptResponse> | null = null;
let lastContextLength = 0;

function killConnection() {
	if (acpProcess) {
		acpProcess.kill();
		acpProcess = null;
	}
	acpConnection = null;
	sessionUpdateHandler = null;
	activeSessionId = null;
	activeModelId = null;
	activePromise = null;
	lastContextLength = 0;

	if (pendingToolCall) {
		pendingToolCall.resolve("Error: connection killed");
		pendingToolCall = null;
	}
	toolCallDetected = null;

	if (bridgeServer) {
		bridgeServer.close();
		bridgeServer = null;
		bridgePort = null;
	}

	if (mcpServerScriptPath) {
		unlink(mcpServerScriptPath).catch(() => {});
		mcpServerScriptPath = null;
	}
}

async function ensureConnection(): Promise<ClientSideConnection> {
	if (acpConnection) return acpConnection;

	const child = spawn("npx", ["-y", "@zed-industries/claude-agent-acp"], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	acpProcess = child;

	let stderrBuffer = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrBuffer += chunk.toString();
	});

	child.on("close", (code) => {
		if (code && code !== 0 && stderrBuffer.trim()) {
			console.error(`[claude-code-acp] ACP process exited ${code}:\n${stderrBuffer.trim()}`);
		}
		acpProcess = null;
		killConnection();
	});

	const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
	const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
	const rawStream = ndJsonStream(input, output);

	// Intercept session/update notifications before SDK validation
	// (workaround for Zod union parse errors in the ACP SDK)
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

	// ACP callbacks — built-in tools are disabled so these are stubs,
	// but the protocol requires them to be registered.
	const connection = new ClientSideConnection(
		() => ({
			sessionUpdate: async () => {},
			requestPermission: async (params) => {
				const opt = params.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
				return opt
					? { outcome: { outcome: "selected", optionId: opt.optionId } }
					: { outcome: { outcome: "cancelled" } };
			},
			readTextFile: async () => ({ content: "" }),
			writeTextFile: async () => ({}),
			createTerminal: async () => ({ terminalId: "stub" }),
			terminalOutput: async () => ({ output: "", truncated: false }),
			waitForTerminalExit: async () => ({ exitCode: 1 }),
			killTerminal: async () => {},
			releaseTerminal: async () => {},
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

process.on("exit", () => killConnection());
process.on("SIGTERM", () => killConnection());

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: { systemPrompt?: string; appendSkills?: boolean; onStreamUpdate?: (responseText: string) => void },
): Promise<{ responseText: string; stopReason: string }> {
	const connection = await ensureConnection();

	// Build _meta: mode preset + skills append + MCP suppression
	const modePreset = MODE_PRESETS[mode] ?? {};
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	const meta: Record<string, unknown> = {
		...modePreset,
		...(skillsBlock ? { systemPrompt: { append: skillsBlock } } : {}),
		claudeCode: {
			options: {
				...(modePreset as any).claudeCode?.options,
				extraArgs: { "strict-mcp-config": null },
			},
		},
	};

	const session = await connection.newSession({
		cwd: process.cwd(),
		mcpServers: [],
		_meta: meta,
	} as any);
	const sid = session.sessionId;
	await connection.setSessionMode({ sessionId: sid, modeId: "bypassPermissions" });

	let responseText = "";

	sessionUpdateHandler = (update: SessionUpdate) => {
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const content = update.content;
				if (content.type === "text" && "text" in content) {
					responseText += (content as { text: string }).text;
					options?.onStreamUpdate?.(responseText);
				}
				break;
			}
			case "tool_call": {
				const tc = update as any;
				toolCalls.set(tc.toolCallId, {
					name: tc.title ?? "tool",
					status: tc.status ?? "pending",
					rawInput: tc.rawInput,
					locations: tc.locations,
				});
				break;
			}
			case "tool_call_update": {
				const tc = update as any;
				const existing = toolCalls.get(tc.toolCallId);
				if (existing) {
					if (tc.title) existing.name = tc.title;
					if (tc.status) existing.status = tc.status;
					if (tc.rawInput !== undefined) existing.rawInput = tc.rawInput;
					if (tc.locations) existing.locations = tc.locations;
				}
				break;
			}
		}
	};

	const onAbort = () => connection.cancel({ sessionId: sid });
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const result = await connection.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: prompt }],
		});
		return { responseText, stopReason: result.stopReason };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sessionUpdateHandler = null;
		connection.unstable_closeSession({ sessionId: sid }).catch(() => {});
	}
}

// --- Core streaming function ---

type RaceResult =
	| { kind: "done"; result: PromptResponse }
	| { kind: "toolCall" };

function waitForToolCall(): Promise<void> {
	return new Promise((resolve) => {
		toolCallDetected = resolve;
	});
}

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
			| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
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

		const closeOpenBlocks = () => {
			if (thinkingBlockIndex !== -1) {
				const block = blocks[thinkingBlockIndex] as { type: "thinking"; thinking: string };
				stream.push({ type: "thinking_end", contentIndex: thinkingBlockIndex, content: block.thinking, partial: output });
				thinkingBlockIndex = -1;
			}
			if (textBlockIndex !== -1) {
				const block = blocks[textBlockIndex] as { type: "text"; text: string };
				stream.push({ type: "text_end", contentIndex: textBlockIndex, content: block.text, partial: output });
				textBlockIndex = -1;
			}
		};

		try {
			const connection = await ensureConnection();
			const tools = getToolsForMcp(context.tools);

			// --- Mode B: Resume with tool result ---
			if (activePromise && pendingToolCall) {
				sessionId = activeSessionId;
				const toolResult = extractLastToolResult(context);
				pendingToolCall.resolve(toolResult?.content || "OK");
				pendingToolCall = null;
				lastContextLength = context.messages.length;

			// --- Mode A: Fresh prompt ---
			} else {
				let promptText: string;
				if (!activeSessionId) {
					// First call — new session with full context
					const mcpServers: Array<{ command: string; args: string[]; env: Array<{ name: string; value: string }>; name: string }> = [];
					if (tools.length > 0) {
						const port = await ensureBridgeServer();
						const bridgeUrl = `http://127.0.0.1:${port}`;
						const scriptPath = await writeMcpServerScript(tools, bridgeUrl);
						mcpServers.push({ command: "node", args: [scriptPath], env: [], name: MCP_SERVER_NAME });
					}

					const session = await connection.newSession({
						cwd: process.cwd(),
						mcpServers,
						_meta: {
							disableBuiltInTools: true,
							claudeCode: { options: { allowedTools: [`mcp__${MCP_SERVER_NAME}__*`] } },
						},
					} as any);

					sessionId = session.sessionId;
					activeSessionId = sessionId;
					await connection.setSessionMode({ sessionId, modeId: "bypassPermissions" });
					await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
					activeModelId = model.id;
					promptText = buildPromptText(context);
					lastContextLength = context.messages.length;
				} else {
					// Continuation — ACP already has prior context
					sessionId = activeSessionId;
					if (activeModelId !== model.id) {
						await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
						activeModelId = model.id;
					}
					const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
					promptText = lastUser ? messageContentToText(lastUser.content) || "" : "";
					lastContextLength = context.messages.length;
				}

				activePromise = connection.prompt({
					sessionId: sessionId!,
					prompt: [{ type: "text", text: promptText }],
				});
			}

			// Wire session update handler
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
							stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta: text, partial: output });
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
							stream.push({ type: "thinking_delta", contentIndex: thinkingBlockIndex, delta: text, partial: output });
						}
						break;
					}

					case "tool_call":
					case "tool_call_update":
						// All tool calls go through MCP bridge → Pi executes them
						break;

					case "usage_update": {
						const usage = update as { used?: number; size?: number } & { sessionUpdate: string };
						if (usage.used != null) {
							output.usage.totalTokens = usage.used;
							output.usage.input = usage.used;
						}
						calculateCost(model, output.usage);
						break;
					}

					default:
						break;
				}
			};

			// Abort handling
			const onAbort = () => {
				if (activeSessionId && acpConnection) {
					acpConnection.cancel({ sessionId: activeSessionId });
				}
				if (pendingToolCall) {
					pendingToolCall.resolve("Error: aborted");
					pendingToolCall = null;
				}
			};
			if (options?.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}

			try {
				// Race: prompt completion vs tool call via bridge
				const raceResult: RaceResult = tools.length > 0
					? await Promise.race([
						activePromise!.then((r): RaceResult => ({ kind: "done", result: r })),
						waitForToolCall().then((): RaceResult => ({ kind: "toolCall" })),
					])
					: await activePromise!.then((r): RaceResult => ({ kind: "done", result: r }));

				if (raceResult.kind === "toolCall" && pendingToolCall) {
					// Tool call detected — return toolUse so Pi executes it
					closeOpenBlocks();
					pushStart();

					const tc = {
						type: "toolCall" as const,
						id: `mcp-tc-${Date.now()}`,
						name: pendingToolCall.toolName,
						arguments: pendingToolCall.args,
					};
					blocks.push(tc);
					const idx = blocks.length - 1;
					stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: output });

					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
					stream.end();
					// activePromise stays alive — next streamSimple call will resume
				} else {
					// Prompt completed
					activePromise = null;
					closeOpenBlocks();

					if (options?.signal?.aborted) {
						output.stopReason = "aborted";
						output.errorMessage = "Operation aborted";
						stream.push({ type: "error", reason: "aborted", error: output });
						stream.end();
						return;
					}

					const result = (raceResult as { kind: "done"; result: PromptResponse }).result;
					output.stopReason = result.stopReason === "cancelled" ? "aborted" : "stop";
					pushStart();
					stream.push({ type: "done", reason: "stop", message: output });
					stream.end();
				}
			} finally {
				if (options?.signal) {
					options.signal.removeEventListener("abort", onAbort);
				}
				sessionUpdateHandler = null;
				toolCallDetected = null;
			}
		} catch (error) {
			activePromise = null;
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

// --- Provider + tool registration ---

const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code. Use for: analysis and second opinions (code review, architecture questions, debugging theories), or autonomous tasks (implement a feature, fix a bug, refactor code). Claude Code's tools are auto-approved — it can read, write, and run commands without user confirmation. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd());

	pi.on("session_shutdown", async () => {
		killConnection();
	});

	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-code-acp",
		apiKey: "not-used",
		api: "claude-code-acp",
		models: MODELS,
		streamSimple: streamClaudeAcp,
	});

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const defaultMode = askConf?.defaultMode ?? "full";

	if (askConf?.enabled !== false) {
		pi.registerTool({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? DEFAULT_TOOL_DESCRIPTION,
			parameters: Type.Object({
				prompt: Type.String({ description: "The question or task for Claude Code. Claude only sees this prompt (no conversation history) — include the user's original question and any relevant context. Don't research up front, let Claude explore." }),
				mode: Type.Optional(StringEnum(["full", "read", "none"] as const, {
					description: `"read": questions about the codebase (review, analysis, explain). "full": tasks that need changes or shell commands. "none": questions that don't involve repo files (general knowledge, brainstorming, opinions).`,
				})),
			}),
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = args.mode ?? defaultMode;
				if (mode !== "full") text += `${theme.fg("muted", `[tools=${mode}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude Code error")
					: theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", "…")}`;
				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-code-acp") {
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-code-acp — you're already running through Claude Code." }],
						details: { error: true },
					};
				}

				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
					});
					clearInterval(progressInterval);
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}

}
