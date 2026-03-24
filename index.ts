import { calculateCost, createAssistantMessageEventStream, getModels, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type SessionNotification, type SessionUpdate, type ToolCall, type ToolCallUpdate, type RequestPermissionRequest, type RequestPermissionResponse, type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest, type WriteTextFileResponse, type CreateTerminalRequest, type CreateTerminalResponse, type TerminalOutputRequest, type TerminalOutputResponse, type WaitForTerminalExitRequest, type WaitForTerminalExitResponse, type KillTerminalRequest, type KillTerminalResponse, type ReleaseTerminalRequest, type ReleaseTerminalResponse } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Writable, Readable } from "node:stream";

const PROVIDER_ID = "claude-code-acp";

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
};

const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	glob: "Glob",
};

const BUILTIN_TOOL_NAMES = new Set(Object.keys(PI_TO_SDK_TOOL_NAME));

const SKILLS_ALIAS_GLOBAL = "~/.claude/skills";
const SKILLS_ALIAS_PROJECT = ".claude/skills";
const GLOBAL_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
const PROJECT_SKILLS_ROOT = join(process.cwd(), ".pi", "skills");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");
const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

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

type SettingSource = "user" | "project" | "local";

type ProviderSettings = {
	appendSystemPrompt?: boolean;
	settingSources?: SettingSource[];
	strictMcpConfig?: boolean;
};

// --- Prompt building ---

function buildPromptText(
	context: Context,
	systemPromptAppend?: string,
): string {
	const parts: string[] = [];

	if (systemPromptAppend) {
		parts.push(systemPromptAppend);
	}

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

// --- Tool name/arg mapping (kept for mapping ACP tool titles back to pi names) ---

function mapToolName(name: string): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	return name;
}

function mapToolArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
	allowSkillAliasRewrite = true,
): Record<string, unknown> {
	const normalized = toolName.toLowerCase();
	const input = args ?? {};
	const resolvePath = (value: unknown) => (allowSkillAliasRewrite ? rewriteSkillAliasPath(value) : value);

	switch (normalized) {
		case "read":
			return {
				path: resolvePath(input.file_path ?? input.path),
				offset: input.offset,
				limit: input.limit,
			};
		case "write":
			return {
				path: resolvePath(input.file_path ?? input.path),
				content: input.content,
			};
		case "edit":
			return {
				path: resolvePath(input.file_path ?? input.path),
				oldText: input.old_string ?? input.oldText ?? input.old_text,
				newText: input.new_string ?? input.newText ?? input.new_text,
			};
		case "bash":
			return {
				command: input.command,
				timeout: input.timeout,
			};
		case "grep":
			return {
				pattern: input.pattern,
				path: resolvePath(input.path),
				glob: input.glob,
				limit: input.head_limit ?? input.limit,
			};
		case "find":
			return {
				pattern: input.pattern,
				path: resolvePath(input.path),
			};
		default:
			return input;
	}
}

// --- Settings & config ---

function loadProviderSettings(): ProviderSettings {
	const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const projectSettings = readSettingsFile(PROJECT_SETTINGS_PATH);
	return { ...globalSettings, ...projectSettings };
}

function readSettingsFile(filePath: string): ProviderSettings {
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const settingsBlock =
			(parsed["claudeCodeAcp"] as Record<string, unknown> | undefined) ??
			(parsed["claude-code-acp"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdkProvider"] as Record<string, unknown> | undefined) ??
			(parsed["claude-agent-sdk-provider"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdk"] as Record<string, unknown> | undefined);
		if (!settingsBlock || typeof settingsBlock !== "object") return {};
		const appendSystemPrompt =
			typeof settingsBlock["appendSystemPrompt"] === "boolean"
				? settingsBlock["appendSystemPrompt"]
				: undefined;

		const settingSourcesRaw = settingsBlock["settingSources"];
		const settingSources =
			Array.isArray(settingSourcesRaw) &&
			settingSourcesRaw.every(
				(value) =>
					typeof value === "string" && (value === "user" || value === "project" || value === "local"),
			)
				? (settingSourcesRaw as SettingSource[])
				: undefined;

		const strictMcpConfig =
			typeof settingsBlock["strictMcpConfig"] === "boolean" ? settingsBlock["strictMcpConfig"] : undefined;

		return { appendSystemPrompt, settingSources, strictMcpConfig };
	} catch {
		return {};
	}
}

// --- Skills & AGENTS.md ---

function extractSkillsAppend(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const startIndex = systemPrompt.indexOf(startMarker);
	if (startIndex === -1) return undefined;
	const endIndex = systemPrompt.indexOf(endMarker, startIndex);
	if (endIndex === -1) return undefined;
	const skillsBlock = systemPrompt.slice(startIndex, endIndex + endMarker.length).trim();
	return rewriteSkillsLocations(skillsBlock);
}

function rewriteSkillsLocations(skillsBlock: string): string {
	return skillsBlock.replace(/<location>([^<]+)<\/location>/g, (_match, location: string) => {
		let rewritten = location;
		if (location.startsWith(GLOBAL_SKILLS_ROOT)) {
			const relPath = relative(GLOBAL_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_GLOBAL}/${relPath}`.replace(/\/\/+/g, "/");
		} else if (location.startsWith(PROJECT_SKILLS_ROOT)) {
			const relPath = relative(PROJECT_SKILLS_ROOT, location).replace(/^\.+/, "");
			rewritten = `${SKILLS_ALIAS_PROJECT}/${relPath}`.replace(/\/\/+/g, "/");
		}
		return `<location>${rewritten}</location>`;
	});
}

function resolveAgentsMdPath(): string | undefined {
	const fromCwd = findAgentsMdInParents(process.cwd());
	if (fromCwd) return fromCwd;
	if (existsSync(GLOBAL_AGENTS_PATH)) return GLOBAL_AGENTS_PATH;
	return undefined;
}

function findAgentsMdInParents(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function extractAgentsAppend(): string | undefined {
	const agentsPath = resolveAgentsMdPath();
	if (!agentsPath) return undefined;
	try {
		const content = readFileSync(agentsPath, "utf-8").trim();
		if (!content) return undefined;
		const sanitized = sanitizeAgentsContent(content);
		return sanitized.length > 0 ? `# CLAUDE.md\n\n${sanitized}` : undefined;
	} catch {
		return undefined;
	}
}

function sanitizeAgentsContent(content: string): string {
	let sanitized = content;
	sanitized = sanitized.replace(/~\/\.pi\b/gi, "~/.claude");
	sanitized = sanitized.replace(/(^|[\s'"`])\.pi\//g, "$1.claude/");
	sanitized = sanitized.replace(/\b\.pi\b/gi, ".claude");
	sanitized = sanitized.replace(/\bpi\b/gi, "environment");
	return sanitized;
}

function rewriteSkillAliasPath(pathValue: unknown): unknown {
	if (typeof pathValue !== "string") return pathValue;
	if (pathValue.startsWith(SKILLS_ALIAS_GLOBAL)) {
		return pathValue.replace(SKILLS_ALIAS_GLOBAL, "~/.pi/agent/skills");
	}
	if (pathValue.startsWith(`./${SKILLS_ALIAS_PROJECT}`)) {
		return pathValue.replace(`./${SKILLS_ALIAS_PROJECT}`, PROJECT_SKILLS_ROOT);
	}
	if (pathValue.startsWith(SKILLS_ALIAS_PROJECT)) {
		return pathValue.replace(SKILLS_ALIAS_PROJECT, PROJECT_SKILLS_ROOT);
	}
	const projectAliasAbs = join(process.cwd(), SKILLS_ALIAS_PROJECT);
	if (pathValue.startsWith(projectAliasAbs)) {
		return pathValue.replace(projectAliasAbs, PROJECT_SKILLS_ROOT);
	}
	return pathValue;
}

// --- Thinking budgets (kept for future use) ---

type ThinkingLevel = NonNullable<SimpleStreamOptions["reasoning"]>;
type NonXhighThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

const DEFAULT_THINKING_BUDGETS: Record<NonXhighThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 16384,
	high: 31999,
};

const OPUS_46_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
	minimal: 2048,
	low: 8192,
	medium: 31999,
	high: 63999,
	xhigh: 63999,
};

function mapThinkingTokens(
	reasoning?: ThinkingLevel,
	modelId?: string,
	thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): number | undefined {
	if (!reasoning) return undefined;

	const isOpus46 = modelId?.includes("opus-4-6") || modelId?.includes("opus-4.6");
	if (isOpus46) {
		return OPUS_46_THINKING_BUDGETS[reasoning];
	}

	const effectiveReasoning: NonXhighThinkingLevel = reasoning === "xhigh" ? "high" : reasoning;

	const customBudgets = thinkingBudgets as (Partial<Record<NonXhighThinkingLevel, number>> | undefined);
	const customBudget = customBudgets?.[effectiveReasoning];
	if (typeof customBudget === "number" && Number.isFinite(customBudget) && customBudget > 0) {
		return customBudget;
	}

	return DEFAULT_THINKING_BUDGETS[effectiveReasoning];
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

		// Track tool call IDs to content block indices
		const toolCallIndexMap = new Map<string, number>();

		try {
			const connection = await ensureConnection();

			// Build system prompt append
			const providerSettings = loadProviderSettings();
			const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
			const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
			const skillsAppend = appendSystemPrompt ? extractSkillsAppend(context.systemPrompt) : undefined;
			const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
			const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

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
				promptText = buildPromptText(context, systemPromptAppend);
				lastContextLength = context.messages.length;
			} else {
				// Continuation — send only new messages
				sessionId = activeSessionId;
				// Update model if changed
				if (activeModelId !== model.id) {
					await connection.unstable_setSessionModel({ sessionId, modelId: model.id });
					activeModelId = model.id;
				}
				const newMessages = context.messages.slice(lastContextLength);
				if (newMessages.length > 0) {
					promptText = buildPromptText({ ...context, messages: newMessages });
				} else {
					// Fallback: send the last user message
					const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
					promptText = lastUser
						? messageContentToText(lastUser.content) || ""
						: "";
				}
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

					case "tool_call": {
						const tc = update as ToolCall & { sessionUpdate: string };
						// Close any open text block before tool call
						if (textBlockIndex !== -1) {
							const textBlock = blocks[textBlockIndex] as { type: "text"; text: string };
							stream.push({ type: "text_end", contentIndex: textBlockIndex, content: textBlock.text, partial: output });
							textBlockIndex = -1;
						}
						// Extract tool name from title (e.g., "Read src/foo.ts" → "Read")
						const titleParts = tc.title.split(" ");
						const rawToolName = titleParts[0] || tc.title;
						const piToolName = mapToolName(rawToolName);
						const args = tc.rawInput
							? mapToolArgs(piToolName, tc.rawInput as Record<string, unknown>)
							: {};

						const block = {
							type: "toolCall" as const,
							id: tc.toolCallId,
							name: piToolName,
							arguments: args,
						};
						blocks.push(block);
						const idx = blocks.length - 1;
						toolCallIndexMap.set(tc.toolCallId, idx);
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						break;
					}

					case "tool_call_update": {
						const tc = update as ToolCallUpdate & { sessionUpdate: string };
						const idx = toolCallIndexMap.get(tc.toolCallId);
						if (idx != null && (tc.status === "completed" || tc.status === "failed")) {
							const block = blocks[idx] as { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
							if (tc.rawInput) {
								block.arguments = mapToolArgs(block.name, tc.rawInput as Record<string, unknown>);
							}
							stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
						}
						break;
					}

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
