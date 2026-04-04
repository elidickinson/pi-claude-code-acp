import { calculateCost, createAssistantMessageEventStream, getModels, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@mariozechner/pi-ai";
import { buildSessionContext, keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSdkMcpServer, query, type EffortLevel, type SDKMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { z } from "zod";
import { pascalCase } from "change-case";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { createSession } from "cc-session-io";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.pi/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = join(homedir(), ".pi", "agent", "claude-bridge.log");
const DIAG_LOG_PATH = join(homedir(), ".pi", "agent", "claude-bridge-diag.log");

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

const PROVIDER_ID = "claude-bridge";

// Global key to prevent re-registration of the provider across module reloads.
//
// When pi-subagents spawns a subagent, the subagent's session loads this module
// again. Without this guard, the subagent's call to registerProvider() would
// overwrite the parent's `streamSimple` function reference in the shared
// ModelRegistry. When the parent later delivers a tool result, it would call
// the subagent's `streamSimple` (which has empty state) instead of its own.
//
// By storing the active streamSimple in a Symbol.for() global (shared across all
// module instances), we ensure only the FIRST instance to register takes effect.
// Subsequent instances wrap the stored function instead of overwriting it.
//
// On session_shutdown (including /reload), clearSession() resets this so a fresh
// registration can occur for the next session.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash", grep: "grep", glob: "find",
};
const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash", grep: "Grep", find: "Glob", glob: "Glob",
};
const MCP_SERVER_NAME = "custom-tools";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronCreate", "CronDelete", "CronList", "TeamCreate", "TeamDelete",
	"WebFetch", "WebSearch", "TodoRead", "TodoWrite",
	"EnterPlanMode", "ExitPlanMode", "RemoteTrigger", "SendMessage",
	"Skill", "TaskOutput", "TaskStop", "ToolSearch",
	"AskUserQuestion", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
];

const LATEST_MODEL_IDS = new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);

const MODELS = getModels("anthropic")
	.filter((model) => LATEST_MODEL_IDS.has(model.id))
	.map((model) => ({
		id: model.id, name: model.name, reasoning: model.reasoning, input: model.input,
		cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
	}));

function resolveModelId(input: string): string {
	const lower = input.toLowerCase();
	for (const id of LATEST_MODEL_IDS) {
		if (id === lower || id.includes(lower)) return id;
	}
	return input;
}

// --- Skills/settings paths ---

const SKILLS_ALIAS_GLOBAL = "~/.claude/skills";
const SKILLS_ALIAS_PROJECT = ".claude/skills";
const GLOBAL_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
const PROJECT_SKILLS_ROOT = join(process.cwd(), ".pi", "skills");
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");
const GLOBAL_AGENTS_PATH = join(homedir(), ".pi", "agent", "AGENTS.md");

// --- Config ---

interface Config {
	maxHistoryMessages?: number;
	askClaude?: {
		enabled?: boolean;
		name?: string;
		label?: string;
		description?: string;
		defaultMode?: "full" | "read" | "none";
		allowFullMode?: boolean;
		appendSkills?: boolean;
	};
}

function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

function loadConfig(cwd: string): Config {
	const global = tryParseJson(join(homedir(), ".pi", "agent", "claude-bridge.json"));
	const project = tryParseJson(join(cwd, ".pi", "claude-bridge.json"));
	const merged: Config = {
		maxHistoryMessages: project.maxHistoryMessages ?? global.maxHistoryMessages,
		askClaude: { ...global.askClaude, ...project.askClaude },
	};
	debug("loadConfig:", JSON.stringify(merged));
	return merged;
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- Text extraction ---

// Text-only extraction — callers: extractUserPrompt, convertAndImportMessages (tool results).
function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type === "image") { debug("messageContentToText: dropping image (text-only path)"); }
		else { debug("messageContentToText: unhandled block type", block.type); parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

// --- AskClaude helpers ---

interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
}

function extractPath(rawInput: unknown): string | undefined {
	if (!rawInput || typeof rawInput !== "object") return undefined;
	const input = rawInput as Record<string, unknown>;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return input.command.substring(0, 80);
	return undefined;
}

function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

function formatToolAction(tc: ToolCallState): string | undefined {
	const path = extractPath(tc.rawInput);
	const verb = tc.name.toLowerCase().split(/\s/)[0];
	if (verb === "read" || verb === "readfile") {
		return path ? `Read(${shortPath(path)})` : "Read";
	} else if (verb === "glob" || verb === "find") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? input.pattern.slice(0, 40) : "";
		return pat ? `Glob(${pat})` : "Glob";
	} else if (verb === "edit" || verb === "write" || verb === "writefile" || verb === "multiedit") {
		return path ? `Edit(${shortPath(path)})` : "Edit";
	} else if (verb === "bash" || verb === "terminal") {
		return `ran ${path ?? "command"}`;
	} else if (verb === "agent") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		return `Agent(${String(input?.description ?? "").slice(0, 40)})`;
	} else if (verb === "grep") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? input.pattern.slice(0, 40) : "";
		return pat ? `Grep(${pat})` : "Grep";
	} else if (verb === "todowrite") {
		const todos = Array.isArray((tc.rawInput as any)?.todos) ? (tc.rawInput as any).todos : [];
		const current = todos.find((t: any) => t.status === "in_progress") ?? todos.find((t: any) => t.status === "pending");
		const label = current ? String(current.content ?? "").slice(0, 40) : "";
		return label || undefined;
	}
	return tc.name;
}

const COLLAPSIBLE_VERBS = new Set(["read", "readfile", "grep", "glob", "find"]);

function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const parts: string[] = [];
	let prevCollapsible = false;
	for (const [, tc] of calls) {
		const action = formatToolAction(tc);
		if (!action) continue;
		const verb = tc.name.toLowerCase().split(/\s/)[0];
		const collapsible = COLLAPSIBLE_VERBS.has(verb);
		// Collapse consecutive collapsible tools — keep only the latest in a run
		if (collapsible && prevCollapsible) {
			parts[parts.length - 1] = action;
		} else {
			parts.push(action);
		}
		prevCollapsible = collapsible;
	}
	return parts.join("; ");
}

// AskClaude mode presets — controls which CC tools are blocked per mode.
// Only block tools that can't work (no pi TUI for user interaction).
// Other CC tools (Agent, SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
];
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
	full: [...ASKCLAUDE_ALWAYS_BLOCKED],
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
}

let sharedSession: SessionState | null = null;

let configuredMaxHistoryMessages: number | undefined;

// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature), and only
// text/image/toolCall block types are handled. If all blocks in an assistant message
// are filtered, the message is dropped — which can create invalid sequences (e.g.
// two user messages in a row, or tool_result without preceding tool_use).
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
): void {
	const limit = configuredMaxHistoryMessages;
	const capped = limit && messages.length > limit ? messages.slice(-limit) : messages;
	if (limit && messages.length > limit) debug(`convertAndImportMessages: capped ${messages.length} → ${limit} messages`);
	const anthropicMessages: Array<{ role: string; content: unknown }> = [];
	// Anthropic requires tool IDs matching ^[a-zA-Z0-9_-]+$ — sanitize IDs from other providers
	const sanitizedIds = new Map<string, string>();
	const sanitizeToolId = (id: string): string => {
		const existing = sanitizedIds.get(id);
		if (existing) return existing;
		const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
		sanitizedIds.set(id, clean);
		return clean;
	};

	for (const msg of capped) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
			} else if (Array.isArray(msg.content)) {
				const parts: unknown[] = [];
				for (const block of msg.content) {
					if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
					} else if (block.type !== "text" && block.type !== "image") {
						debug("convertAndImportMessages: dropping user block type", (block as any).type);
					}
				}
				anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
			} else {
				anthropicMessages.push({ role: "user", content: "[empty]" });
			}
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks: unknown[] = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = (block as any).thinkingSignature;
					const isAnthropicProvider = (msg as any).provider === PROVIDER_ID
						|| (msg as any).api === "anthropic";
					if (isAnthropicProvider && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					} else {
						debug("convertAndImportMessages: dropping thinking block — provider:", (msg as any).provider, "api:", (msg as any).api, "hasSig:", Boolean(sig));
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id), name: toolName, input: block.arguments ?? {} });
				} else {
					debug("convertAndImportMessages: dropping assistant block type", (block as any).type);
				}
			}
			if (blocks.length) anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const text = typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
			anthropicMessages.push({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId), content: text || "", is_error: msg.isError }],
			});
		}
	}

	debug(`convertAndImportMessages: ${capped.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c as any[]).map((b: any) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	if (anthropicMessages.length) session.importMessages(anthropicMessages as any);
}

type McpContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

function toolResultToMcpContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): McpContent {
	if (typeof content === "string") return [{ type: "text", text: content || "" }];
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const blocks: McpContent = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function msgPreview(msg: { role: string; content?: unknown }): string {
	const c = msg.content;
	const text = typeof c === "string" ? c : Array.isArray(c) ? (c[0] as any)?.text ?? (c[0] as any)?.type ?? "?" : "?";
	return `${msg.role}:${JSON.stringify(typeof text === "string" ? text.slice(0, 60) : text)}`;
}

// Extract tool results for the current turn from the end of context.
// Stops at the nearest assistant or user message — only collects results from THIS turn.
function extractAllToolResults(context: Context): McpResult[] {
	const results: McpResult[] = [];
	let stopIdx = -1;
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "toolResult") {
			results.unshift({ content: toolResultToMcpContent(msg.content), isError: msg.isError });
		} else if (msg.role === "user" || msg.role === "assistant") { stopIdx = i; break; }
	}
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}]${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") return last.content;
	return messageContentToText(last.content) || "";
}

/** Extract the last user message as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return null;
	if (typeof last.content === "string") {
		debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
		return null;
	}
	if (!Array.isArray(last.content)) {
		debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
		return null;
	}
	debug(`extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b: any) => b.type).join(",")}`);
	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of last.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
			if (!(block as any).data || !(block as any).mimeType) {
				debug(`image block missing data or mimeType, skipping`);
				continue;
			}
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
			});
		}
	}
	return hasImage ? blocks : null;
}

async function* wrapPromptStream(blocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: blocks } as MessageParam,
		parent_tool_use_id: null,
	};
}


interface SyncResult {
	sessionId: string | null;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
): SyncResult {
	const priorMessages = messages.slice(0, -1); // everything before the new user prompt

	if (!sharedSession) {
		if (priorMessages.length === 0) {
			debug(`Case 1: clean start, ${messages.length} total messages`);
			return { sessionId: null };
		}
		const session = createSession({ projectPath: cwd, ...(modelId ? { model: modelId } : {}) });
		convertAndImportMessages(session, priorMessages, customToolNameToSdk);
		session.save();
		sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
		return { sessionId: session.sessionId };
	}

	const missed = priorMessages.slice(sharedSession.cursor);
	if (missed.length === 0) {
		debug(`Case 3: no missed messages, resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		return { sessionId: sharedSession.sessionId };
	}

	// Case 4: create fresh session with ALL prior messages (injecting into existing session
	// creates a branch that Claude Code doesn't follow on resume)
	const session = createSession({ projectPath: sharedSession.cwd, ...(modelId ? { model: modelId } : {}) });
	convertAndImportMessages(session, priorMessages, customToolNameToSdk);
	session.save();
	const oldSessionId = sharedSession.sessionId;
	sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd: sharedSession.cwd };
	debug(`Case 4: ${missed.length} missed messages, ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${oldSessionId.slice(0, 8)}), ${session.messages.length} records`);
	return { sessionId: session.sessionId };
}

// Extract skills block from pi's system prompt for forwarding to Claude Code
function extractSkillsBlock(systemPrompt?: string): string | undefined {
	if (!systemPrompt) return undefined;
	const startMarker = "The following skills provide specialized instructions for specific tasks.";
	const endMarker = "</available_skills>";
	const start = systemPrompt.indexOf(startMarker);
	if (start === -1) return undefined;
	const end = systemPrompt.indexOf(endMarker, start);
	if (end === -1) return undefined;
	return rewriteSkillsLocations(systemPrompt.slice(start, end + endMarker.length).trim());
}

// --- Provider helpers: tool name mapping ---

function mapPiToolNameToSdk(name?: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	if (normalized.startsWith(MCP_TOOL_PREFIX)) return name.slice(MCP_TOOL_PREFIX.length);
	return name;
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

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
	grep:  { head_limit: "limit" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined, allowSkillAliasRewrite = true,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	if (allowSkillAliasRewrite && typeof result.path === "string") {
		result.path = rewriteSkillAliasPath(result.path);
	}
	// Pi bash has no default timeout; add a safety default
	if (toolName.toLowerCase() === "bash" && result.timeout == null) {
		result.timeout = 120;
	}
	return result;
}

// --- Provider helpers: system prompt ---


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

// --- Provider helpers: settings ---

type ProviderSettings = {
	appendSystemPrompt?: boolean;
	settingSources?: SettingSource[];
	strictMcpConfig?: boolean;
};

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
			(parsed["claudeAgentSdkProvider"] as Record<string, unknown> | undefined) ??
			(parsed["claude-agent-sdk-provider"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdk"] as Record<string, unknown> | undefined);
		if (!settingsBlock || typeof settingsBlock !== "object") return {};
		const appendSystemPrompt =
			typeof settingsBlock["appendSystemPrompt"] === "boolean" ? settingsBlock["appendSystemPrompt"] : undefined;
		const settingSourcesRaw = settingsBlock["settingSources"];
		const settingSources =
			Array.isArray(settingSourcesRaw) &&
			settingSourcesRaw.every((value) => typeof value === "string" && (value === "user" || value === "project" || value === "local"))
				? (settingSourcesRaw as SettingSource[])
				: undefined;
		const strictMcpConfig =
			typeof settingsBlock["strictMcpConfig"] === "boolean" ? settingsBlock["strictMcpConfig"] : undefined;
		return { appendSystemPrompt, settingSources, strictMcpConfig };
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${filePath}: ${e}`);
		return {};
	}
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

interface McpResult { content: McpContent; isError?: boolean; [key: string]: unknown }

interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

// Module-level state for the push-based streaming pattern.
// WARNING: pi loads extensions in-process via jiti. Despite moduleCache:false,
// Node's native import cache (tryNative:true) can cause extensions that spawn
// their own pi sessions (subagents, AskClaude, etc.) to share this module instance.
// The queryStateStack below protects the parent query's state from reentrant corruption.
let activeQuery: ReturnType<typeof query> | null = null;
let currentPiStream: ReturnType<typeof createAssistantMessageEventStream> | null = null;

// Symmetric queues for matching MCP handlers ↔ tool results.
// At any time, at most ONE of these has entries (never both):
//   pendingToolCalls — MCP handlers blocked on a Promise, waiting for a result
//   pendingResults   — tool results delivered by pi, waiting for an MCP handler
// Positional: both queues are FIFO; the SDK fires handlers in tool_use order,
// and pi delivers results in the same order.
let pendingToolCalls: PendingToolCall[] = [];
let pendingResults: McpResult[] = [];

// State stack: when a subagent starts a fresh query while the main query is active,
// we save the main's state and restore it when the subagent's query ends.
interface SavedQueryState {
	activeQuery: typeof activeQuery;
	currentPiStream: typeof currentPiStream;
	pendingToolCalls: PendingToolCall[];
	pendingResults: McpResult[];
}
const queryStateStack: SavedQueryState[] = [];

// Per-turn output state (reset on each streamSimple call that starts a new pi turn)
let turnOutput: AssistantMessage | null = null;
let turnBlocks: Array<any> = [];
let turnStarted = false;
let turnSawStreamEvent = false;
let turnSawToolCall = false;

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// --- TypeBox → Zod schema conversion ---
//
// Pi tools use TypeBox (JSON Schema objects). The SDK's MCP server needs Zod.
//
// Why: createSdkMcpServer's tools/list handler calls zodToJsonSchema() on each
// tool's inputSchema. It detects Zod via the `~standard` marker or `_def`/`_zod`
// properties (see `Z0()` in sdk.mjs). Plain JSON Schema objects silently fall
// back to `{type: "object", properties: {}}` — the model sees no params.
//
// If this breaks after an SDK update, check whether `Z0()` detection changed
// or whether createSdkMcpServer now accepts raw JSON Schema.

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum)) base = z.enum(prop.enum as [string, ...string[]]);
	else switch (prop.type) {
		case "string": base = z.string(); break;
		case "number": case "integer": base = z.number(); break;
		case "boolean": base = z.boolean(); break;
		case "array": base = prop.items
			? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
			: z.array(z.unknown()); break;
		case "object": base = z.record(z.string(), z.unknown()); break;
		default: base = z.unknown();
	}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	const s = schema as Record<string, unknown>;
	if (!s || s.type !== "object" || !s.properties) return {};
	const props = s.properties as Record<string, Record<string, unknown>>;
	const required = new Set(Array.isArray(s.required) ? s.required as string[] : []);
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(props)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Matching is purely positional (FIFO) — the SDK fires handlers in tool_use
// order and pi delivers results in the same order. The tool.name in logs is
// the registered tool definition, not necessarily the tool the SDK is calling.
function buildMcpServers(tools: Tool[]): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodShape(tool.parameters),
		handler: async () => {
			if (pendingResults.length > 0) {
				const result = pendingResults.shift()!;
				debug(`mcp handler: ${tool.name} → resolved from queue (${pendingResults.length} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} → waiting`);
			return new Promise<McpResult>((resolve) => {
				pendingToolCalls.push({ toolName: tool.name, resolve });
			});
		},
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!currentPiStream` guard in
// consumeQuery and are skipped before resetTurnState runs.

function resetTurnState(model: Model<any>): void {
	turnOutput = {
		role: "assistant", content: [],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	};
	turnBlocks = turnOutput.content as Array<any>;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
}

function ensureTurnStarted(): void {
	if (!turnStarted && currentPiStream && turnOutput) {
		currentPiStream.push({ type: "start", partial: turnOutput });
		turnStarted = true;
	}
}

function finalizeCurrentStream(stopReason?: string): void {
	if (!currentPiStream || !turnOutput) return;
	// DEBUG: trace stream finalization
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: turnOutput.stopReason, error: turnOutput.errorMessage})}`);
	if (!turnStarted) ensureTurnStarted();
	const reason = stopReason === "length" ? "length" : "stop";
	currentPiStream.push({ type: "done", reason, message: turnOutput });
	currentPiStream.end();
	currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	allowSkillAliasRewrite: boolean,
	model: Model<any>,
): void {
	if (!currentPiStream || !turnOutput) return;
	turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		if (event.message?.usage) updateUsage(turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted();
		if (event.content_block?.type === "text") {
			turnBlocks.push({ type: "text", text: "", index: event.index });
			currentPiStream.push({ type: "text_start", contentIndex: turnBlocks.length - 1, partial: turnOutput });
		} else if (event.content_block?.type === "thinking") {
			turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			currentPiStream.push({ type: "thinking_start", contentIndex: turnBlocks.length - 1, partial: turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			turnSawToolCall = true;
			turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: mapToolName(event.content_block.name, customToolNameToPi),
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			currentPiStream.push({ type: "toolcall_start", contentIndex: turnBlocks.length - 1, partial: turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			currentPiStream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			currentPiStream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			currentPiStream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			currentPiStream.push({ type: "text_end", contentIndex: index, content: block.text, partial: turnOutput });
		} else if (block.type === "thinking") {
			currentPiStream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: turnOutput });
		} else if (block.type === "toolCall") {
			turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments), allowSkillAliasRewrite,
			);
			delete block.partialJson;
			currentPiStream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop" && turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		turnOutput.stopReason = "toolUse";
		currentPiStream.push({ type: "done", reason: "toolUse", message: turnOutput });
		currentPiStream.end();
		currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, allowSkillAliasRewrite: boolean): void {
	if (turnSawStreamEvent) return;
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted();
			turnBlocks.push({ type: "text", text: block.text });
			const idx = turnBlocks.length - 1;
			currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: turnOutput });
			currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: turnOutput });
			currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted();
			turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = turnBlocks.length - 1;
			currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: turnOutput });
			if (block.thinking) currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: turnOutput });
			currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: turnOutput });
		} else if (block.type === "tool_use") {
			ensureTurnStarted();
			turnSawToolCall = true;
			const mappedArgs = mapToolArgs(mapToolName(block.name, customToolNameToPi), block.input, allowSkillAliasRewrite);
			turnBlocks.push({
				type: "toolCall", id: block.id,
				name: mapToolName(block.name, customToolNameToPi),
				arguments: mappedArgs,
			});
			const idx = turnBlocks.length - 1;
			const toolBlock = turnBlocks[idx];
			currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: turnOutput });
			currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && turnOutput) updateUsage(turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (turnSawToolCall && currentPiStream && turnOutput) {
		turnOutput.stopReason = "toolUse";
		currentPiStream.push({ type: "done", reason: "toolUse", message: turnOutput });
		currentPiStream.end();
		currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	allowSkillAliasRewrite: boolean,
	model: Model<any>,
	wasAborted: () => boolean,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		if (wasAborted()) break;
		if (!currentPiStream || !turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, allowSkillAliasRewrite, model);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, allowSkillAliasRewrite);
				break;
			case "result":
				if (!turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted();
					const text = message.result || "";
					turnBlocks.push({ type: "text", text });
					const idx = turnBlocks.length - 1;
					currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: turnOutput });
					currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: turnOutput });
					currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: turnOutput });
				}
				break;
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId };
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${activeQuery !== null}`);

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (activeQuery) {
		currentPiStream = stream;
		resetTurnState(model);
		const allResults = extractAllToolResults(context);
		debug(`provider: tool results, ${allResults.length} results, ${pendingToolCalls.length} waiting handlers, ctx.msgs=${context.messages.length}`);
		for (const result of allResults) {
			if (pendingToolCalls.length > 0) {
				const pending = pendingToolCalls.shift()!;
				debug(`provider: resolving ${pending.toolName}${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
				pending.resolve(result);
				debug(`provider: pending.resolve called, SDK should continue...`);
			} else {
				pendingResults.push(result);
				debug(`provider: queued result (${pendingResults.length} pending)`);
			}
			// Invariant: at most one queue has entries at any time
			if (pendingToolCalls.length > 0 && pendingResults.length > 0) {
				debug(`BUG: both queues non-empty! handlers=${pendingToolCalls.length} results=${pendingResults.length}`);
			}
		}
		if (sharedSession) sharedSession.cursor = context.messages.length;
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message.
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (sharedSession) sharedSession.cursor = context.messages.length;
		queueMicrotask(() => {
			resetTurnState(model);
			stream.push({ type: "done", reason: "stop", message: turnOutput });
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// If a query is already active, a reentrant call is starting (e.g. subagent,
	// AskClaude, or any extension spawning its own pi session) while the parent
	// query is suspended. Save the parent's state so we can restore it when done.
	const isReentrant = activeQuery !== null;
	if (isReentrant) {
		queryStateStack.push({
			activeQuery,
			currentPiStream,
			pendingToolCalls: [...pendingToolCalls],
			pendingResults: [...pendingResults],
		});
		debug(`provider: saving state (stack depth ${queryStateStack.length}), reentrant fresh query`);
	}

	currentPiStream = stream;
	pendingToolCalls.length = 0;
	pendingResults.length = 0;
	resetTurnState(model);

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const { sessionId: resumeSessionId } = syncSharedSession(context.messages, cwd, customToolNameToSdk, model.id);
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with the state stack fix — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			stackDepth: queryStateStack.length,
			activeQueryExists: activeQuery !== null,
			sharedSession: sharedSession ? { sessionId: sharedSession.sessionId.slice(0, 8), cursor: sharedSession.cursor } : null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	const prompt: string | AsyncIterable<SDKUserMessage> = promptBlocks
		? wrapPromptStream(promptBlocks)
		: promptText;
	const mcpServers = buildMcpServers(mcpTools);
	const providerSettings = loadProviderSettings();
	const appendSystemPrompt = providerSettings.appendSystemPrompt !== false;
	const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
	const skillsAppend = appendSystemPrompt ? extractSkillsBlock(context.systemPrompt) : undefined;
	const appendParts = [agentsAppend, skillsAppend].filter((part): part is string => Boolean(part));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
	const allowSkillAliasRewrite = Boolean(skillsAppend);

	// MCP auto-loading suppression: CC auto-loads MCP servers from ~/.claude.json and
	// .mcp.json when filesystem settings are loaded. Since pi executes tools (not CC),
	// auto-loaded MCP tools are pure token overhead. Two mechanisms prevent this:
	//   appendSystemPrompt=true  (default): settingSources=undefined → SDK isolation mode,
	//     no filesystem settings loaded, so no MCP auto-discovery occurs.
	//   appendSystemPrompt=false: settingSources loads user/project settings, but
	//     --strict-mcp-config tells CC to ignore auto-discovered MCP configs.
	const settingSources: SettingSource[] | undefined = appendSystemPrompt
		? undefined
		: providerSettings.settingSources ?? ["user", "project"];
	const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;

	const extraArgs: Record<string, string | null> = { model: model.id };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;

	const effort = options?.reasoning ? REASONING_TO_EFFORT[options.reasoning] : undefined;

	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		disallowedTools: DISALLOWED_BUILTIN_TOOLS,
		allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		systemPrompt: {
			type: "preset", preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
		},
		extraArgs,
		...(effort ? { effort } : {}),
		...(settingSources ? { settingSources } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
	};

	debug("provider: fresh query",
		`model=${model.id} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`appendSys=${appendSystemPrompt} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

	let wasAborted = false;
	const sdkQuery = query({ prompt, options: queryOptions });
	activeQuery = sdkQuery;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		for (const pending of pendingToolCalls) { pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] }); }
		pendingToolCalls.length = 0;
		pendingResults.length = 0;
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, allowSkillAliasRewrite, model, () => wasAborted)
		.then(({ capturedSessionId }) => {
			// DEBUG: trace what happens after tool result
			debug(`provider: consumeQuery completed, stopReason=${turnOutput?.stopReason}, error=${turnOutput?.errorMessage}`);
			// Capture the SDK session ID for future resume. The `context` closure is
			// from the initial streamSimple call and is stale — tool result deliveries
			// advanced sharedSession.cursor past it. We keep whichever is higher.
			// Note: pi appends the final assistant message AFTER streamSimple returns,
			// so cursor is always 1 behind — syncSharedSession will trigger a Case 4
			// rebuild on the next turn. This is correct but not efficient.
			if (!wasAborted) {
				const sessionId = capturedSessionId ?? sharedSession?.sessionId;
				if (sessionId) {
					const cursor = Math.max(context.messages.length, sharedSession?.cursor ?? 0);
					debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
					sharedSession = { sessionId, cursor, cwd };
				}
			}

			if (wasAborted || options?.signal?.aborted) {
				if (turnOutput) {
					turnOutput.stopReason = "aborted";
					turnOutput.errorMessage = "Operation aborted";
				}
				currentPiStream?.push({ type: "error", reason: "aborted", error: turnOutput! });
				currentPiStream?.end();
				currentPiStream = null;
			} else {
				finalizeCurrentStream(turnOutput?.stopReason);
			}
		})
		.catch((error) => {
			debug(`provider: query error, model=${model.id}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if (turnOutput) {
				turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				turnOutput.errorMessage = error instanceof Error ? error.message : String(error);
			}
			currentPiStream?.push({ type: "error", reason: (turnOutput?.stopReason ?? "error") as "aborted" | "error", error: turnOutput! });
			currentPiStream?.end();
			currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			if (activeQuery === sdkQuery) {
				// Drain this query's queues before restoring parent state
				for (const pending of pendingToolCalls) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
				pendingToolCalls.length = 0;
				pendingResults.length = 0;

				// If this was a reentrant query, restore the parent's state
				if (isReentrant && queryStateStack.length > 0) {
					const saved = queryStateStack.pop()!;
					activeQuery = saved.activeQuery;
					currentPiStream = saved.currentPiStream;
					pendingToolCalls.length = 0;
					pendingToolCalls.push(...saved.pendingToolCalls);
					pendingResults.length = 0;
					pendingResults.push(...saved.pendingResults);
					debug(`provider: restored state (stack depth ${queryStateStack.length})`);
				} else {
					// DEBUG: trace when activeQuery is cleared
					debug(`provider: clearing activeQuery (non-reentrant), pending handlers=${pendingToolCalls.length}, pendingResults=${pendingResults.length}`);
					activeQuery = null;
				}
			}
			sdkQuery.close();
		});

	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = process.cwd();
	const modelId = resolveModelId(options?.model ?? "opus");

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update sharedSession.cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		if (sharedSession) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = sharedSession.sessionId;
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
			const sync = syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, modelId);
			resumeSessionId = sync.sessionId;
		}
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	// Skills append
	const skillsBlock = options?.appendSkills !== false && options?.systemPrompt
		? extractSkillsBlock(options.systemPrompt) : undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off"
		? REASONING_TO_EFFORT[options.thinking] : undefined;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: modelId,
	};

	debug("askClaude:",
		`mode=${mode} model=${modelId} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} prompt=${prompt.slice(0, 60)}`);

	const sdkQuery = query({
		prompt,
		options: {
			cwd,
			permissionMode: "bypassPermissions",
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			systemPrompt: skillsBlock
				? { type: "preset", preset: "claude_code", append: skillsBlock }
				: undefined,
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	if (signal?.aborted) { onAbort(); throw new Error("Aborted"); }
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;

			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						toolCalls.set(event.content_block.id, {
							name: event.content_block.name,
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: block.name,
								status: "complete",
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		return { responseText, stopReason: wasAborted ? "cancelled" : "stop" };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	configuredMaxHistoryMessages = config.maxHistoryMessages;

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
		sharedSession = null;

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	pi.on("session_shutdown", () => clearSession("session_shutdown"));

	// --- Provider ---
	//
	// Guard against re-registration when the module is loaded multiple times
	// (e.g., when spawning subagents). The shared ModelRegistry would otherwise
	// overwrite the parent's streamSimple, breaking tool result delivery.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: MODELS,
			streamSimple: streamClaudeAgentSdk,
		});
	} else {
		// Subsequent instance (subagent session): skip registration entirely.
		// The subagent already has access to claude-bridge models via the shared
		// ModelRegistry from the parent's registration. Calls to those models
		// will route through the parent's streamSimple via the reentrant
		// queryStateStack mechanism.
		debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode !== false;
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
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", `… (${keyHint("expandTools", "to expand")})`)}`;

				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code." }],
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
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
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
					debug(`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${params.isolated ?? false}, error=`, err);
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
