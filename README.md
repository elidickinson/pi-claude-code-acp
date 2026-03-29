# pi-claude-bridge (experimental)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Provides two ways to use Claude Code from pi:

> Built on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal — the provider skeleton, tool name mapping, and settings loading originate from that project. This fork adds streaming, MCP tool bridging, context sync with pi, thinking support, and the AskClaude tool.

1. **Provider** — Offers Opus/Sonnet/Haiku as models that can be selected in pi like usual
2. **AskClaude tool** — Pi can use this to delegate tasks or ask questions of Claude Code without switching from another model/provider

Behind the scenes, it drives a real Claude Code session via the Agent SDK's `query()` API and uses an in-process MCP server to bridge tool calls from Claude Code back to pi where they are executed.

This is a fully compliant way to use a Claude Max/Pro subscription — only the real Claude Code touches Anthropic's API and requests are part of a user-driven coding session.

(IANAL and obviously this extension is unofficial and neither endorsed nor supported by Anthropic.)


<a href="screenshot.png"><img src="screenshot.png" width="600"></a>

## Setup

1. Install via git (recommended while experimental):
   ```
   pi install git:github.com/elidickinson/pi-claude-bridge
   ```

2. Ensure Claude Code is installed and logged in (`claude` CLI works).

3. Reload pi: `/reload`

## Provider

Provider ID: `claude-bridge`

Use `/model` to select:
- `claude-bridge/claude-opus-4-6`
- `claude-bridge/claude-sonnet-4-6`
- `claude-bridge/claude-haiku-4-5`

Claude Code's built-in tools are denied execution. Instead, pi's tools are forwarded via an in-process MCP server (`createSdkMcpServer`) so all tool calls flow through pi — pi sees every tool call in the TUI and maintains control. The tradeoff is that tool names show up as `mcp__custom-tools__Read` etc. instead of native names.

### Context across provider switches

Each provider turn sends the full conversation history as a fresh `query()` call. When you switch away from the provider (e.g., to OpenRouter) and back, the messages from the other provider are flattened into text and included automatically. No JSONL mirroring or session resume needed — the SDK handles context as a simple message array.

## AskClaude Tool

Available when using any non-claude-bridge provider. Pi's LLM can delegate to Claude Code for second opinions, analysis, or autonomous tasks.

**Default tool description** (what pi sees):

> **AskClaude** - Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.

You can override this description via config (see below). You can also steer when and how AskClaude gets called by adding instructions to a skill or AGENTS.md — e.g., "Always call AskClaude in read mode to review any complicated feature implementations before the task can be considered complete."

**Parameters:**
- `prompt` — the question or task
- `mode` — tool access preset:
  - `"read"` (default): read-only codebase access — for review, analysis, research
  - `"none"`: no tools, reasoning only — for general questions, brainstorming
  - `"full"`: read, write, run commands — requires `allowFullMode: true` in config (see below)
- `model` — Claude model to use (e.g., `"opus"`, `"sonnet"`, `"haiku"`, or full ID). Defaults to Opus.
- `thinking` — extended thinking effort level:
  - `"off"` — disable extended thinking
  - `"minimal"`, `"low"`, `"medium"` (default), `"high"`, `"xhigh"` — increasing thinking depth
- `isolated` — when `true`, Claude sees only this prompt (clean session). When `false` (default), Claude sees the full conversation history as a text summary.

Unlike the provider, AskClaude uses Claude Code's own built-in tools directly (Glob, Read, etc.) — not pi's tools via MCP. This means tool calls happen inside Claude Code and pi only sees the final result. Claude Code's tools are auto-approved (bypass permissions mode). Pre-existing MCP servers from user/project config are suppressed via `--strict-mcp-config`. Pi's skills are forwarded to Claude Code's system prompt.

### Shared vs isolated mode

By default, AskClaude sees the full conversation history via `buildSessionContext()` — pi's messages are flattened into `USER:`/`ASSISTANT:`/`TOOL RESULT:` text blocks wrapped in `<conversation_context>`. This lets Claude answer questions about prior discussion ("what was the secret word?") without needing the caller to repeat context.

Set `isolated: true` for a clean-slate session — useful when the conversation context would be distracting or irrelevant.

## Configuration

Config files: `~/.pi/agent/claude-bridge.json` (global) and `.pi/claude-bridge.json` (project overrides global).

```json
{
  "askClaude": {
    "enabled": true,
    "name": "AskClaude",
    "label": "Ask Claude Code",
    "description": "Custom tool description override",
    "defaultMode": "full",
    "appendSkills": true
  }
}
```

- `"enabled": false` — disable the AskClaude tool
- `"allowFullMode": true` — enable full mode (read + write + run). Off by default — AskClaude only offers read and none modes unless this is set.
- `"appendSkills": false` — don't forward pi's skills to Claude Code

## Limitations

**Claude Code loads its own skills** from `~/.claude/skills/` and `.claude/skills/` in addition to the pi skills we forward. These are additive — Claude Code may have skills pi doesn't know about.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug logging to `~/.pi/agent/claude-bridge.log`.

## Architecture

Both modes use the Agent SDK's `query()` API but with different tool strategies:

- **Provider** denies Claude Code's built-in tools and bridges pi's tools in via MCP (`createSdkMcpServer()`). This gives pi full visibility and control — every tool call appears in the TUI — but tool names show up as `mcp__custom-tools__*`.
- **AskClaude** uses Claude Code's native tools directly, with `disallowedTools` restricting access per mode (`full`/`read`/`none`). This is faster and cleaner, but pi only sees the final result, not individual tool calls.
- **Context**: conversation history flattened to text via `buildSessionContext()`

## TODOs

- **Markdown rendering** in expanded tool result view. Currently plain text — code blocks, headings, lists render as raw syntax. Use `Markdown` from `@mariozechner/pi-tui` with a `MarkdownTheme` built from pi's theme. Requires returning a `Box` instead of `Text` from `renderResult`.
- **Persistent AskClaude session**: reuse the same Claude Code session across calls so context accumulates (e.g., plan a feature → implement → review). The SDK supports session resume. Tradeoff: `disallowedTools` is set per-query, so mode restrictions can change per-call, but the session accumulates all prior tool outputs.
- **`/claude config` slash command** for runtime configuration. Currently the only way to change settings is to edit the JSON file and `/reload`.
- **`/claude:btw` command** for ephemeral questions: quick question, response displayed but not added to LLM context.
