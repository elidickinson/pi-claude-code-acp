#!/usr/bin/env node
// Test: synthetic session records form a single parent chain after SDK resume.
//
// Creates a synthetic session via cc-session-io, runs a minimal SDK query
// with resume, then verifies the resulting JSONL has one connected chain
// (no orphaned synthetic records).

import { createSession, parseJsonlFile } from "cc-session-io";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use the project root so cc-session-io and the SDK agree on path
const projectPath = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

// --- Step 1: Create synthetic session with 2 user/assistant turns ---
const session = createSession({ projectPath, model: "claude-haiku-4-5-20251001" });

session.addUserMessage("The secret word is 'banana'. Acknowledge.");
session.addAssistantMessage([{ type: "text", text: "Got it — the secret word is banana." }]);

session.addUserMessage("What is the secret word?");
session.addAssistantMessage([{ type: "text", text: "The secret word is banana." }]);

session.save();

console.log(`Session: ${session.sessionId}`);
console.log(`JSONL:   ${session.jsonlPath}`);
console.log(`Records before SDK query: ${session.records.length}`);

// --- Step 2: Resume session with SDK query ---
const sdkQuery = query({
	prompt: "What was the secret word? Reply with just the word, nothing else.",
	options: {
		resume: session.sessionId,
		cwd: projectPath,
		permissionMode: "bypassPermissions",
		disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "WebSearch", "WebFetch"],
		maxTurns: 1,
	},
});

// Drain the generator
for await (const msg of sdkQuery) {
	// Just consume — we only care about the JSONL output
}

// --- Step 3: Read resulting JSONL and verify parent chain ---
const records = parseJsonlFile(session.jsonlPath);
console.log(`Records after SDK query: ${records.length}`);

// Build uuid → index map
const uuidToIdx = new Map();
for (let i = 0; i < records.length; i++) {
	const uuid = records[i].uuid;
	if (uuid) uuidToIdx.set(uuid, i);
}

// Show the chain for debugging
console.log("\nParent chain:");
for (let i = 0; i < records.length; i++) {
	const rec = records[i];
	const parentIdx = rec.parentUuid ? uuidToIdx.get(rec.parentUuid) ?? "?" : "ROOT";
	const role = rec.message?.role ?? rec.type;
	console.log(`  [${i}] ${rec.type.padEnd(18)} parent→[${parentIdx}] role=${role}`);
}

// Find message records (user + assistant)
const msgRecords = records.filter(r => r.type === "user" || r.type === "assistant");

// Walk from the LAST message record back to ROOT via parentUuid
const lastMsg = msgRecords[msgRecords.length - 1];
const visited = new Set();
let current = lastMsg;
while (current) {
	visited.add(current.uuid);
	if (!current.parentUuid) break;
	const parentIdx = uuidToIdx.get(current.parentUuid);
	current = parentIdx != null ? records[parentIdx] : null;
}

// Every message record should be reachable from the last one
const orphaned = msgRecords.filter(r => !visited.has(r.uuid));

if (orphaned.length > 0) {
	console.log(`\nFAIL: ${orphaned.length} orphaned message records (not reachable from chain tail):`);
	for (const r of orphaned) {
		const idx = records.indexOf(r);
		console.log(`  [${idx}] ${r.type} role=${r.message?.role}`);
	}
	process.exit(1);
} else {
	console.log(`\nPASS: all ${msgRecords.length} message records form a single chain`);
}
