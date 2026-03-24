# pi-claude-code-acp

This extension registers a custom provider that routes LLM calls through **Claude Code via ACP** (Agent Client Protocol). Claude Code handles the full agentic loop — including tool execution — while pi streams and displays the results.

## Highlights

- Claude Code runs as a subprocess via ACP, handling LLM calls and tool execution.
- Built-in tools (Read, Write, Edit, Bash, Grep, Glob) are executed by Claude Code via client-side callbacks.
- Tool calls are streamed back to pi for display.
- Skills and AGENTS.md can be appended to the prompt (optional).

## Demo

![Demo](screenshot.png)

## Setup

1) Install the extension globally:

```
pi install npm:pi-claude-code-acp
```

(You can pin a specific version for reproducible installs.)

2) **Authenticate**: Ensure Claude Code is set up and authenticated (e.g., `claude` CLI works).

3) Reload pi:

```
/reload
```

## Provider ID

`claude-code-acp`

Use `/model` to select:
- `claude-code-acp/claude-opus-4-5`
- `claude-code-acp/claude-haiku-4-5`

## Tool Behavior

Claude Code handles tool execution internally via ACP. The provider streams tool call events back to pi for display. Pi does not execute tools — Claude Code does.

## Context loading

1) **Append to system prompt (Default)**
   - Uses **AGENTS.md + skills** from pi and appends to the prompt sent to Claude Code.
   - No extra config needed.

2) **Disable append**
   - Set `appendSystemPrompt: false` so Claude Code uses only its own CLAUDE.md and settings.

   **Config:**
   ```json
   {
     "claudeCodeAcp": {
       "appendSystemPrompt": false
     }
   }
   ```
