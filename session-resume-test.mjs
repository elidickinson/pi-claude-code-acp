#!/usr/bin/env node
// Context continuity test for pi-claude-bridge provider.
// Verifies that switching away from the provider and back correctly
// preserves conversation context (all messages are flattened into
// each query, so "missed" messages are automatically included).
//
// Also tests AskClaude shared mode (sees conversation history) vs
// isolated mode (clean slate).
//
// Requires: pi CLI, Claude Code (for Agent SDK subprocess).

console.log("=== session-resume-test.mjs ===");

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const DIR = dirname(fileURLToPath(import.meta.url));
const LOGDIR = `${DIR}/.test-output`;
const LOGFILE = `${LOGDIR}/session-resume.log`;
const TIMEOUT = 180_000;

const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const OTHER_PROVIDER = "openrouter";
const OTHER_MODEL = "openai/gpt-5-nano";

// Random words to avoid Claude memorizing test values across runs
const WORD_A = `alpha${Math.random().toString(36).slice(2, 6)}`;
const WORD_B = `beta${Math.random().toString(36).slice(2, 6)}`;
const WORD_C = `gamma${Math.random().toString(36).slice(2, 6)}`;


// Strip node_modules/.bin from PATH (shadows pi with vendored types package)
process.env.PATH = process.env.PATH
  .split(":")
  .filter((p) => !p.includes("node_modules"))
  .join(":");

const log = createWriteStream(LOGFILE);

// Spawn pi in RPC mode — start on non-provider model to test Case 2 (first provider turn with prior history)
const pi = spawn("pi", [
  "--no-session", "-ne",
  "-e", DIR,
  "--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`,
  "--mode", "rpc",
], { stdio: ["pipe", "pipe", "pipe"] });

pi.stderr.on("data", (d) => log.write(d));

// JSONL reader
let buffer = "";
const decoder = new StringDecoder("utf8");
const listeners = [];

pi.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (true) {
    const i = buffer.indexOf("\n");
    if (i === -1) break;
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    try {
      const msg = JSON.parse(line);
      log.write(`< ${line}\n`);
      for (const fn of listeners) fn(msg);
    } catch {}
  }
});

let reqId = 0;
function send(cmd) {
  const id = `req_${++reqId}`;
  const full = { ...cmd, id };
  log.write(`> ${JSON.stringify(full)}\n`);
  pi.stdin.write(JSON.stringify(full) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${cmd.type}`)), 30_000);
    listeners.push(function handler(msg) {
      if (msg.type === "response" && msg.id === id) {
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(handler), 1);
        if (msg.success) resolve(msg.data);
        else reject(new Error(`${cmd.type}: ${msg.error}`));
      }
    });
  });
}

function waitForIdle(timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for idle")), timeout);
    listeners.push(function handler(msg) {
      if (msg.type === "agent_end") {
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(handler), 1);
        // Extract last tool result text for assertion
        const toolResults = msg.messages?.filter((m) => m.role === "toolResult") ?? [];
        if (toolResults.length > 0) {
          const last = toolResults[toolResults.length - 1];
          lastToolResult = last.content?.map((c) => c.text ?? "").join("") ?? "";
        }
        resolve(msg);
      }
    });
  });
}

function collectText() {
  let text = "";
  const handler = (msg) => {
    if (msg.type === "message_update") {
      const ae = msg.assistantMessageEvent;
      if (ae?.type === "text_delta") text += ae.delta;
    }
  };
  listeners.push(handler);
  return { stop() { listeners.splice(listeners.indexOf(handler), 1); return text; } };
}

let lastToolResult = null;

async function promptAndWait(message) {
  const collector = collectText();
  await send({ type: "prompt", message });
  await waitForIdle();
  return collector.stop();
}

function finish(code, msg) {
  console.log(msg);
  if (code !== 0) console.log(`  Log: ${LOGFILE}`);
  pi.kill();
  log.end(() => process.exit(code));
}

// Give pi a moment to initialize
await new Promise((r) => setTimeout(r, 2000));

try {
  // Turn 1: Non-provider prompt — establishes context before our provider is used
  console.log("Turn 1: Non-provider prompt (establish context)...");
  const text1 = await promptAndWait(`The secret word is '${WORD_A}'. Acknowledge and be very brief.`);
  if (!text1) finish(1, "FAIL: Turn 1 produced no text");
  console.log(`  Response: ${text1.slice(0, 80)}`);

  // Switch to provider — first provider turn with prior history (Case 2)
  const [bridgeProvider, bridgeModelId] = BRIDGE_MODEL.split("/");
  console.log(`Switching to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });

  // Turn 2: First provider turn — should see WORD_A from prior non-provider history
  console.log("Turn 2: First provider turn with prior history (Case 2)...");
  const text2 = await promptAndWait(
    `The backup word is '${WORD_B}'. Also, what was the secret word? Reply with both words separated by a comma.`
  );
  console.log(`  Response: ${text2.slice(0, 80)}`);
  const lower2 = text2.toLowerCase();
  if (!lower2.includes(WORD_A)) finish(1, `FAIL: Turn 2 response missing '${WORD_A}': ${text2}`);
  if (!lower2.includes(WORD_B)) finish(1, `FAIL: Turn 2 response missing '${WORD_B}': ${text2}`);

  // Switch to other model — creates missed messages
  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  // Turn 3: Non-provider prompt — adds context that provider must see on switch-back
  console.log("Turn 3: Non-provider prompt (creates missed messages)...");
  const text3 = await promptAndWait(`The third word is '${WORD_C}'. Acknowledge briefly.`);
  if (!text3) finish(1, "FAIL: Turn 3 produced no text");
  console.log(`  Response: ${text3.slice(0, 80)}`);

  // Switch back to provider — context includes all prior turns (Case 4)
  console.log(`Switching back to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });

  // Turn 4: Provider resumes with missed messages (Case 4)
  console.log("Turn 4: Provider resume with missed messages (Case 4)...");
  const text4 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas."
  );
  console.log(`  Response: ${text4.slice(0, 80)}`);
  const lower4 = text4.toLowerCase();
  if (!lower4.includes(WORD_A)) finish(1, `FAIL: Turn 4 response missing '${WORD_A}': ${text4}`);
  if (!lower4.includes(WORD_B)) finish(1, `FAIL: Turn 4 response missing '${WORD_B}': ${text4}`);
  if (!lower4.includes(WORD_C)) finish(1, `FAIL: Turn 4 response missing '${WORD_C}': ${text4}`);

  // Turn 5: AskClaude shared mode — should see WORD_C which was only told to the non-provider model
  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  console.log("Turn 5: AskClaude shared mode (should see non-provider context)...");
  const text5 = await promptAndWait(
    'Use the AskClaude tool with prompt="What was the third word mentioned earlier? Reply with just the word."'
  );
  console.log(`  AskClaude result: ${(lastToolResult || "").slice(0, 120)}`);
  if (!lastToolResult?.toLowerCase().includes(WORD_C)) finish(1, `FAIL: Turn 5 AskClaude tool result missing '${WORD_C}': ${lastToolResult}`);

  // Turn 6: AskClaude isolated mode — should NOT see conversation history
  console.log("Turn 6: AskClaude isolated mode (should not see context)...");
  lastToolResult = null;
  const text6 = await promptAndWait(
    'Use the AskClaude tool with prompt="What was the third word mentioned earlier? If you don\'t know, say UNKNOWN." and isolated=true'
  );
  console.log(`  AskClaude result: ${(lastToolResult || "").slice(0, 120)}`);
  if (lastToolResult?.toLowerCase().includes(WORD_C)) finish(1, `FAIL: Turn 6 isolated AskClaude should not know '${WORD_C}': ${lastToolResult}`);

  finish(0, "PASS");
} catch (e) {
  finish(1, `FAIL: ${e.message}`);
}
