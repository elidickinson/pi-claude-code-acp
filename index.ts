import { calculateCost, createAssistantMessageEventStream, getModels, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import { buildSessionContext, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type SessionNotification, type SessionUpdate, type PromptResponse } from "@agentclientprotocol/sdk";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import { createSession, openSession, type Session } from "cc-session-io";

/** Extract a useful message from any thrown value (Error, plain object, or primitive). */
function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch { /* fall through */ }
	}
	return String(err);
}

const PROVIDER_ID = "claude-code-acp";
const MCP_SERVER_NAME = "pi-tools";

/** Max messages to seed into a Claude Code session JSONL. Keeps most recent, drops oldest. */
const MAX_MIRROR_MESSAGES = 40;

const LATEST_MODEL_IDS = new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);

/** Resolve short model names (e.g. "sonnet") to full CC model IDs. */
function resolveModelId(input: string): string {
	const lower = input.toLowerCase();
	for (const id of LATEST_MODEL_IDS) {
		if (id === lower || id.includes(lower)) return id;
	}
	return input;
}

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
		allowFullMode?: boolean;  // default false — enable full (read+write+run) mode
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

function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	// For absolute paths outside cwd, keep last 2 segments for brevity
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

const ABS_PATH_RE = /\/(?:Users|home|tmp|var|opt|usr|private|nix)\b[^\s`'"]{10,}/g;

function shortenName(name: string): string {
	return name.replace(ABS_PATH_RE, shortPath);
}

function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const reads = new Set<string>();
	const edits = new Set<string>();
	const commands: string[] = [];
	const other: string[] = [];

	for (const [, tc] of calls) {
		const path = tcPath(tc);
		const verb = tc.name.toLowerCase().split(/\s/)[0];
		if (verb === "read" || verb === "readfile") {
			if (path) reads.add(shortPath(path));
		} else if (verb === "edit" || verb === "write" || verb === "writefile" || verb === "multiedit") {
			if (path) edits.add(shortPath(path));
		} else if (verb === "bash" || verb === "terminal") {
			commands.push(path ?? "command");
		} else {
			other.push(shortenName(tc.name));
		}
	}

	const parts: string[] = [];
	if (reads.size) parts.push(`read ${[...reads].join(", ")}`);
	if (edits.size) parts.push(`edited ${[...edits].join(", ")}`);
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
	read: { claudeCode: { options: { disallowedTools: [
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete",
		"TeamCreate", "TeamDelete",
	] } } },
	none: { claudeCode: { options: { disallowedTools: [
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	] } } },
};

// Built-in CC tools to block when using the provider (MCP bridge replaces them).
// disableBuiltInTools is ineffective with bypassPermissions; disallowedTools works.
const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
	"WebFetch", "WebSearch", "TodoRead", "TodoWrite",
	"EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
	"Skill", "TaskOutput", "TaskStop",
];

// --- Provider helpers ---

function getToolsForMcp(tools?: Tool[], excludeName?: string): Tool[] {
	if (!tools) return [];
	return excludeName ? tools.filter(t => t.name !== excludeName) : tools;
}

// --- Text extraction helpers ---

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
			server.unref();
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
	const path = join(tmpdir(), `pi-tools-mcp-${randomUUID()}.js`);
	await writeFile(path, script, "utf-8");
	mcpServerScriptPath = path;
	return path;
}

type McpServer = { command: string; args: string[]; env: Array<{ name: string; value: string }>; name: string };

async function buildMcpServers(tools: Tool[]): Promise<McpServer[]> {
	if (tools.length === 0) return [];
	const port = await ensureBridgeServer();
	const scriptPath = await writeMcpServerScript(tools, `http://127.0.0.1:${port}`);
	return [{ command: "node", args: [scriptPath], env: [], name: MCP_SERVER_NAME }];
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

// --- Session mirroring via cc-session ---

let mirrorSessionId: string | null = null;
let mirrorCursor: number = 0;

/** Translate pi messages into cc-session records.
 *  When skipOwnAssistant is true, assistant messages from our provider are
 *  skipped because CC already wrote them to the JSONL itself. */
function mirrorPiMessages(session: Session, messages: Context["messages"], skipOwnAssistant = false): void {
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: messageContentToText(msg.content) || "[image]";
			session.addUserMessage(text);
		} else if (msg.role === "assistant") {
			if (skipOwnAssistant && (msg as any).provider === PROVIDER_ID) continue;
			// Thinking signatures are model-specific — only signatures from our own
			// provider (i.e. produced by CC itself) are safe to replay on resume.
			// Other providers (including native anthropic with a different model)
			// may have incompatible signatures that the API rejects.
			const isOwnProvider = (msg as any).provider === PROVIDER_ID;
			const blocks: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string; signature: string } | { type: "tool_use"; id: string; name: string; input: unknown }> = [];
			if (typeof msg.content === "string") {
				blocks.push({ type: "text", text: msg.content });
			} else {
				for (const block of msg.content) {
					if (block.type === "text") {
						blocks.push({ type: "text", text: block.text ?? "" });
					} else if (block.type === "thinking") {
						const sig = (block as any).thinkingSignature;
						if (isOwnProvider && sig) {
							blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
						}
					} else if (block.type === "toolCall") {
						blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} });
					}
				}
			}
			if (blocks.length > 0) {
				session.addAssistantMessage(blocks);
			}
		} else if (msg.role === "toolResult") {
			const content = messageContentToText(msg.content) || "";
			session.addToolResults([{ toolUseId: msg.toolCallId, content, isError: msg.isError }]);
		}
	}
}

/** Mirror pi messages into a CC session JSONL, creating or appending as needed. */
function ensureMirrorSession(messages: Context["messages"], cwd: string, skipOwnAssistant = false): string {
	if (mirrorSessionId) {
		const ccSession = openSession({ sessionId: mirrorSessionId, projectPath: cwd });
		mirrorPiMessages(ccSession, messages.slice(-MAX_MIRROR_MESSAGES), skipOwnAssistant);
		ccSession.save();
	} else {
		const ccSession = createSession({ projectPath: cwd });
		mirrorPiMessages(ccSession, messages.slice(-MAX_MIRROR_MESSAGES));
		ccSession.save();
		mirrorSessionId = ccSession.sessionId;
	}
	return mirrorSessionId!;
}

function resetMirror(): void {
	mirrorSessionId = null;
	mirrorCursor = 0;
}

// --- ACP connection management ---

let acpProcess: ChildProcess | null = null;
let acpConnection: ClientSideConnection | null = null;
let sessionUpdateHandler: ((update: SessionUpdate) => void) | null = null;
let activeSessionId: string | null = null;
let activeModelId: string | null = null;
let activePromise: Promise<PromptResponse> | null = null;

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

	if (pendingToolCall) {
		pendingToolCall.resolve("Error: connection killed");
		pendingToolCall = null;
	}
	toolCallDetected = null;
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
		const text = chunk.toString();
		stderrBuffer += text;
		if (process.env.CLAUDE_ACP_DEBUG) console.error(`[claude-code-acp] stderr: ${text.trimEnd()}`);
	});

	child.on("close", (code) => {
		if (code && code !== 0 && stderrBuffer.trim()) {
			console.error(`[claude-code-acp] ACP process exited ${code}:\n${stderrBuffer.trim()}`);
		}
		// Only clean up if this is still the active process — a new one may
		// have been spawned already (killConnection + ensureConnection cycle).
		if (acpProcess === child) {
			acpProcess = null;
			killConnection();
		}
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

process.on("exit", () => { killConnection(); });
process.on("SIGTERM", () => { killConnection(); });

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string; appendSkills?: boolean; onStreamUpdate?: (responseText: string) => void;
		model?: string; thinking?: string; isolated?: boolean; context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = process.cwd();

	// Build _meta: mode preset + skills append
	const modePreset = MODE_PRESETS[mode] ?? {};
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	const extraArgs: Record<string, string | null> = { "strict-mcp-config": null };
	if (options?.thinking) extraArgs["effort"] = options.thinking;

	const meta: Record<string, unknown> = {
		...modePreset,
		...(skillsBlock ? { systemPrompt: { append: skillsBlock } } : {}),
		claudeCode: {
			options: {
				...(modePreset as any).claudeCode?.options,
				extraArgs,
			},
		},
	};

	let connection: ClientSideConnection;
	let sid: string;

	if (options?.isolated) {
		// Isolated mode: fresh session, no conversation history
		connection = await ensureConnection();
		const session = await connection.newSession({ cwd, mcpServers: [], _meta: meta } as any);
		sid = session.sessionId;
		await connection.setSessionMode({ sessionId: sid, modeId: "bypassPermissions" });
	} else {
		// Shared mode (default): mirror pi context into CC session, kill/reconnect to resume.
		// Safe to killConnection: AskClaude is only callable when a non-ACP model is active
		// (execute guard rejects calls from the ACP provider), so no activePromise exists.
		if (options?.context && options.context.length > 0) {
			ensureMirrorSession(options.context, cwd, true);
		}
		killConnection();
		connection = await ensureConnection();
		sid = await createAcpSession(connection, cwd, [], mirrorSessionId || undefined, meta);
		activeSessionId = null; // provider's session is stale after kill
	}

	await connection.unstable_setSessionModel({ sessionId: sid, modelId: resolveModelId(options?.model ?? "opus") });

	let responseText = "";

	const handler = (update: SessionUpdate) => {
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

	sessionUpdateHandler = handler;

	// Race prompt against abort signal — cancel() alone can't guarantee prompt() resolves promptly
	const onAbort = () => { connection.cancel({ sessionId: sid }).catch(() => {}); };
	const abortP = signal ? new Promise<never>((_, reject) => {
		const fire = () => { onAbort(); reject(new Error("Aborted")); };
		if (signal.aborted) { fire(); return; }
		signal.addEventListener("abort", fire, { once: true });
	}) : null;

	try {
		const promptP = connection.prompt({ sessionId: sid, prompt: [{ type: "text", text: prompt }] });
		const result = abortP ? await Promise.race([promptP, abortP]) : await promptP;
		return { responseText, stopReason: result.stopReason };
	} finally {
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
		// If a tool call already arrived before we started listening, resolve immediately
		if (pendingToolCall) {
			resolve();
			return;
		}
		toolCallDetected = resolve;
	});
}

let askClaudeToolName = "AskClaude";

async function createAcpSession(
	conn: ClientSideConnection, cwd: string, mcpServers: McpServer[],
	resume?: string, meta?: Record<string, unknown>,
): Promise<string> {
	const metaOptions = (meta as any)?.claudeCode?.options ?? {};
	const session = await conn.newSession({
		cwd,
		mcpServers,
		_meta: {
			...meta,
			claudeCode: { options: {
				...metaOptions,
				allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
				disallowedTools: [
					...DISALLOWED_BUILTIN_TOOLS,
					...(metaOptions.disallowedTools ?? []),
				],
				...(resume ? { resume } : {}),
			} },
		},
	} as any);
	await conn.setSessionMode({ sessionId: session.sessionId, modeId: "bypassPermissions" });
	return session.sessionId;
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
			let connection = await ensureConnection();
			const tools = getToolsForMcp(context.tools, askClaudeToolName);

			// --- Mode B: Resume with tool result ---
			// Pi expects tool execution between separate streamSimple() calls, but
			// Claude Code's prompt() stays alive waiting for tool results via MCP.
			// Mode B bridges the gap: resolve the pending HTTP bridge request with
			// pi's tool result, letting the still-alive prompt() continue.
			if (activePromise && pendingToolCall) {
				sessionId = activeSessionId;
				const toolResult = extractLastToolResult(context);
				pendingToolCall.resolve(toolResult?.content || "OK");
				pendingToolCall = null;
				mirrorCursor = context.messages.length;

			// --- Mode A: Fresh prompt ---
			} else {
				const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
				const lastUserText = lastUser ? messageContentToText(lastUser.content) || "" : "";

				const cwd = process.cwd();

				if (!activeSessionId) {
					// First call — seed JSONL with recent context, set up MCP, create session
					const contextWithoutLast = context.messages.slice(0, -1);
					if (contextWithoutLast.length > 0) {
						ensureMirrorSession(contextWithoutLast, cwd);
					}

					const mcpServers = await buildMcpServers(tools);
					sessionId = await createAcpSession(connection, cwd, mcpServers, mirrorSessionId || undefined);
					activeSessionId = sessionId;
					if (!mirrorSessionId) mirrorSessionId = sessionId;
					await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
					activeModelId = model.id;
					mirrorCursor = context.messages.length;
				} else {
					// Continuation — reuse existing session
					sessionId = activeSessionId;
					const missed = context.messages.slice(mirrorCursor, -1);
					if (missed.length > 0) {
						if (!mirrorSessionId) throw new Error("mirrorSessionId must be set when activeSessionId exists");
						ensureMirrorSession(missed, cwd, true);

						killConnection();
						const mcpServers = await buildMcpServers(tools);
						connection = await ensureConnection();
						sessionId = await createAcpSession(connection, cwd, mcpServers, mirrorSessionId!);
						activeSessionId = sessionId;
					}
					if (activeModelId !== model.id) {
						await connection.unstable_setSessionModel({ sessionId: sessionId!, modelId: model.id });
						activeModelId = model.id;
					}
					mirrorCursor = context.messages.length;
				}

				activePromise = connection.prompt({
					sessionId: sessionId!,
					prompt: [{ type: "text", text: lastUserText }],
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

				// Note: We intentionally do NOT update usage from streaming 'usage_update'
				// events. Token counts are taken from the final PromptResponse.usage,
				// which is the authoritative source. Streaming approximations are
				// unnecessary since we don't display real-time tok/s.

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
					if (result.usage) {
						output.usage.input = result.usage.inputTokens;
						output.usage.output = result.usage.outputTokens;
						output.usage.cacheRead = result.usage.cachedReadTokens ?? 0;
						output.usage.cacheWrite = result.usage.cachedWriteTokens ?? 0;
						output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
					}
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
			console.error("[claude-code-acp] provider prompt error:", error);
			if (!acpConnection || acpProcess === null) {
				killConnection();
			}

			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = errorMessage(error);
			if (!started) stream.push({ type: "start", partial: output });
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();

	return stream;
}

// --- Provider + tool registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

export default function (pi: ExtensionAPI) {
	const config = loadConfig(process.cwd());

	pi.on("session_shutdown", async () => {
		killConnection();
		resetMirror();
		if (bridgeServer) { bridgeServer.close(); bridgeServer = null; bridgePort = null; }
		if (mcpServerScriptPath) { unlink(mcpServerScriptPath).catch(() => {}); mcpServerScriptPath = null; }
	});
	pi.on("session_switch", async () => {
		killConnection();
		resetMirror();
	});
	pi.on("session_fork", async () => {
		killConnection();
		resetMirror();
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
	const allowFull = askConf?.allowFullMode === true;
	const defaultMode = askConf?.defaultMode ?? "read";
	askClaudeToolName = askConf?.name ?? "AskClaude";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		pi.registerTool({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: Type.Object({
				prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
				mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
				model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
				thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
				isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
			}),
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = args.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== "full") tags.push(`tools=${mode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (args.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
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
						model: params.model,
						thinking: params.thinking,
						isolated: params.isolated,
						context: params.isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
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
					console.error("[claude-code-acp] AskClaude error:", err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}

}
