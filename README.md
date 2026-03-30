# pi-claude-bridge (experimental)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

> Built on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal — the provider skeleton, tool name mapping, and settings loading originate from that project. This fork adds streaming, MCP tool bridging, context sync with pi, thinking support, and the AskClaude tool.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate to Claude Code for a second opinion without switching providers

Uses your Claude Max/Pro subscription. Only the real Claude Code touches Anthropic's API so as best I can tell using this with pi complies with Anthropic terms. Obviously this extension is not endorsed or supported by Anthropic.

<a href="screenshot.png"><img src="screenshot.png" width="600"></a>

## Setup

1. Install:
   ```
   pi install npm:pi-claude-bridge
   ```

2. Ensure Claude Code is installed and logged in (`claude` CLI works).

3. Reload pi: `/reload`

## Provider

Use `/model` to select `claude-bridge/claude-opus-4-6`, `claude-bridge/claude-sonnet-4-6`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but it should all work like normal in pi.

## AskClaude Tool

Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Modes

- `read` (default) — Claude Code can explore the codebase but not make changes
- `none` — reasoning only, no tools
- `full` — read + write + run commands (requires `allowFullMode: true` in config)

By default, AskClaude sees the full conversation history. Set `isolated: true` for a clean-slate session.

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or `.pi/claude-bridge.json` (project).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "description": "Custom tool description override"
  }
}
```

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to log to `~/.pi/agent/claude-bridge.log`.

## Maintenance

After updating Claude Code or the Agent SDK, check for new built-in tools that may need adding to `DISALLOWED_BUILTIN_TOOLS` in `index.ts`. Unrecognized CC tools leak through to pi as tool calls it can't handle. Symptoms: "Tool X not found" errors in pi.
