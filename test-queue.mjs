/**
 * Tests for the symmetric queue synchronization between MCP handlers and tool results.
 * Exercises all timing orderings without hitting any API.
 */
import assert from "node:assert/strict";

// --- Extracted queue logic (mirrors index.ts pendingToolCalls/pendingResults) ---

function createBridge() {
	const pendingHandlers = []; // { resolve }
	const pendingResults = []; // { content, isError? }

	return {
		// Called by MCP handler: resolve immediately from queue, or block.
		waitForResult() {
			if (pendingResults.length > 0) return Promise.resolve(pendingResults.shift());
			return new Promise((resolve) => { pendingHandlers.push({ resolve }); });
		},

		// Called by tool result delivery: resolve a waiting handler, or queue.
		deliverResult(result) {
			if (pendingHandlers.length > 0) {
				pendingHandlers.shift().resolve(result);
			} else {
				pendingResults.push(result);
			}
		},

		// Called on abort/query end.
		drain(fallback) {
			for (const h of pendingHandlers) h.resolve(fallback);
			pendingHandlers.length = 0;
			pendingResults.length = 0;
		},

		get handlersWaiting() { return pendingHandlers.length; },
		get resultsQueued() { return pendingResults.length; },

		// Invariant: at most one queue is non-empty.
		assertMutualExclusion() {
			assert.ok(
				!(pendingHandlers.length > 0 && pendingResults.length > 0),
				`Mutual exclusion violated: ${pendingHandlers.length} handlers, ${pendingResults.length} results`,
			);
		},
	};
}

let pass = 0;
let fail = 0;

async function test(name, fn) {
	try {
		await fn();
		console.log(`  PASS  ${name}`);
		pass++;
	} catch (e) {
		console.log(`  FAIL  ${name}: ${e.message}`);
		fail++;
	}
}

// --- Scenario A: results arrive before handlers ---

console.log("Scenario A: results before handlers");

await test("N results queued, then N handlers resolve immediately", async () => {
	const bridge = createBridge();
	const results = [{ content: [{ type: "text", text: "r0" }] }, { content: [{ type: "text", text: "r1" }] }, { content: [{ type: "text", text: "r2" }] }];
	for (const r of results) bridge.deliverResult(r);
	assert.equal(bridge.resultsQueued, 3);
	assert.equal(bridge.handlersWaiting, 0);
	bridge.assertMutualExclusion();

	for (let i = 0; i < 3; i++) {
		const got = await bridge.waitForResult();
		assert.equal(got.content[0].text, `r${i}`);
	}
	assert.equal(bridge.resultsQueued, 0);
	assert.equal(bridge.handlersWaiting, 0);
});

// --- Scenario B: handlers arrive before results ---

console.log("Scenario B: handlers before results");

await test("N handlers block, then N results resolve them in order", async () => {
	const bridge = createBridge();
	const promises = [];
	for (let i = 0; i < 3; i++) promises.push(bridge.waitForResult());
	assert.equal(bridge.handlersWaiting, 3);
	assert.equal(bridge.resultsQueued, 0);
	bridge.assertMutualExclusion();

	for (let i = 0; i < 3; i++) bridge.deliverResult({ content: [{ type: "text", text: `r${i}` }] });
	const resolved = await Promise.all(promises);
	for (let i = 0; i < 3; i++) assert.equal(resolved[i].content[0].text, `r${i}`);
	assert.equal(bridge.handlersWaiting, 0);
	assert.equal(bridge.resultsQueued, 0);
});

// --- Scenario C: interleaved ---

console.log("Scenario C: interleaved");

await test("handler blocks → result resolves → result queued → handler immediate", async () => {
	const bridge = createBridge();
	const p1 = bridge.waitForResult(); // blocks
	assert.equal(bridge.handlersWaiting, 1);

	bridge.deliverResult({ content: [{ type: "text", text: "r0" }] }); // resolves p1
	assert.equal(bridge.handlersWaiting, 0);
	const got1 = await p1;
	assert.equal(got1.content[0].text, "r0");

	bridge.deliverResult({ content: [{ type: "text", text: "r1" }] }); // queued
	assert.equal(bridge.resultsQueued, 1);
	bridge.assertMutualExclusion();

	const got2 = await bridge.waitForResult(); // immediate from queue
	assert.equal(got2.content[0].text, "r1");
	assert.equal(bridge.resultsQueued, 0);
});

// --- Scenario D: positional ordering with identity ---

console.log("Scenario D: positional ordering");

await test("results always match handlers by position", async () => {
	const bridge = createBridge();
	const N = 7;
	// Mix: first 3 handlers arrive, then 5 results, then 4 more handlers
	const promises = [];
	for (let i = 0; i < 3; i++) promises.push(bridge.waitForResult());
	for (let i = 0; i < 5; i++) bridge.deliverResult({ content: [{ type: "text", text: `r${i}` }] });
	for (let i = 3; i < N; i++) promises.push(bridge.waitForResult());
	for (let i = 5; i < N; i++) bridge.deliverResult({ content: [{ type: "text", text: `r${i}` }] });

	const resolved = await Promise.all(promises);
	for (let i = 0; i < N; i++) {
		assert.equal(resolved[i].content[0].text, `r${i}`, `handler ${i} got wrong result`);
	}
	bridge.assertMutualExclusion();
});

// --- Scenario E: abort ---

console.log("Scenario E: abort");

await test("drain resolves all waiting handlers with fallback", async () => {
	const bridge = createBridge();
	const promises = [];
	for (let i = 0; i < 4; i++) promises.push(bridge.waitForResult());
	bridge.deliverResult({ content: [{ type: "text", text: "r0" }] });
	// 3 still waiting, 1 resolved
	const fallback = { content: [{ type: "text", text: "aborted" }] };
	bridge.drain(fallback);
	const resolved = await Promise.all(promises);
	assert.equal(resolved[0].content[0].text, "r0");
	for (let i = 1; i < 4; i++) assert.equal(resolved[i].content[0].text, "aborted");
	assert.equal(bridge.handlersWaiting, 0);
	assert.equal(bridge.resultsQueued, 0);
});

await test("drain clears queued results", async () => {
	const bridge = createBridge();
	bridge.deliverResult({ content: [{ type: "text", text: "stale" }] });
	bridge.deliverResult({ content: [{ type: "text", text: "stale" }] });
	assert.equal(bridge.resultsQueued, 2);
	bridge.drain({ content: [] });
	assert.equal(bridge.resultsQueued, 0);
	// New handler should block, not get stale data
	const p = bridge.waitForResult();
	assert.equal(bridge.handlersWaiting, 1);
	bridge.deliverResult({ content: [{ type: "text", text: "fresh" }] });
	const got = await p;
	assert.equal(got.content[0].text, "fresh");
});

// --- Scenario F: isError propagation ---

console.log("Scenario F: isError propagation");

await test("isError flag flows through both paths", async () => {
	const bridge = createBridge();
	// Path 1: result queued, handler picks up
	bridge.deliverResult({ content: [{ type: "text", text: "err" }], isError: true });
	const got1 = await bridge.waitForResult();
	assert.equal(got1.isError, true);

	// Path 2: handler blocks, result resolves
	const p = bridge.waitForResult();
	bridge.deliverResult({ content: [{ type: "text", text: "ok" }], isError: false });
	const got2 = await p;
	assert.equal(got2.isError, false);
});

// --- Scenario G: fresh query after drain (no stale state) ---

console.log("Scenario G: fresh query after drain");

await test("new query sees clean state after drain", async () => {
	const bridge = createBridge();
	// Query 1: deliver results and handlers, then drain mid-flight
	bridge.deliverResult({ content: [{ type: "text", text: "q1-stale" }] });
	const p = bridge.waitForResult();
	bridge.deliverResult({ content: [{ type: "text", text: "q1-stale2" }] });
	await p; // resolves with q1-stale
	assert.equal(bridge.resultsQueued, 1); // q1-stale2 sitting in queue
	bridge.drain({ content: [] });
	assert.equal(bridge.resultsQueued, 0);
	assert.equal(bridge.handlersWaiting, 0);

	// Query 2: fresh start — handler must not see q1 data
	const p2 = bridge.waitForResult();
	assert.equal(bridge.handlersWaiting, 1);
	bridge.deliverResult({ content: [{ type: "text", text: "q2-fresh" }] });
	const got = await p2;
	assert.equal(got.content[0].text, "q2-fresh");
});

// --- Scenario H: extractAllToolResults must stop at assistant messages ---
// Regression: extractAllToolResults only stopped at "user", not "assistant".
// In a multi-turn agentic loop (user → assistant → toolResult × N → assistant → toolResult × M),
// it collected ALL tool results from the entire conversation, not just the current turn.
// This fed stale results into the queue, causing result/tool_use mismatches.

console.log("Scenario H: extractAllToolResults boundaries");

// Minimal reimplementation of extractAllToolResults for testing
function extractAllToolResults(messages) {
	const results = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			results.unshift({ content: msg.content, isError: msg.isError });
		} else if (msg.role === "user" || msg.role === "assistant") {
			break;
		}
	}
	return results;
}

await test("single turn: collects all tool results after assistant", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "t1" }, { type: "toolCall", name: "read", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t1", content: "file1" },
		{ role: "toolResult", toolCallId: "t2", content: "file2" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2);
	assert.equal(results[0].content, "file1");
	assert.equal(results[1].content, "file2");
});

await test("multi-turn: only collects results from current turn, not previous", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", name: "read", id: "t1" }, { type: "toolCall", name: "read", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t1", content: "file1-OLD" },
		{ role: "toolResult", toolCallId: "t2", content: "file2-OLD" },
		// Second turn
		{ role: "assistant", content: [{ type: "toolCall", name: "grep", id: "t3" }] },
		{ role: "toolResult", toolCallId: "t3", content: "grep-result-NEW" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 1, `expected 1 result (current turn), got ${results.length}`);
	assert.equal(results[0].content, "grep-result-NEW");
});

await test("three turns: only last turn's results", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
		{ role: "toolResult", toolCallId: "t1", content: "turn1" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t2" }] },
		{ role: "toolResult", toolCallId: "t2", content: "turn2" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t3" }, { type: "toolCall", id: "t4" }] },
		{ role: "toolResult", toolCallId: "t3", content: "turn3a" },
		{ role: "toolResult", toolCallId: "t4", content: "turn3b" },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 2);
	assert.equal(results[0].content, "turn3a");
	assert.equal(results[1].content, "turn3b");
});

await test("no tool results at end returns empty", async () => {
	const messages = [
		{ role: "user", content: "prompt" },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	];
	const results = extractAllToolResults(messages);
	assert.equal(results.length, 0);
});

// --- Scenario I: property-based fuzz (FUZZ=1 to enable) ---

if (process.env.FUZZ) {
console.log("Scenario G: fuzz (1000 random orderings)");

await test("random delivery/handler orderings always drain correctly", async () => {
	for (let trial = 0; trial < 1000; trial++) {
		const bridge = createBridge();
		const n = Math.floor(Math.random() * 8) + 1;
		const ops = [];
		for (let i = 0; i < n; i++) ops.push({ type: "deliver", idx: i });
		for (let i = 0; i < n; i++) ops.push({ type: "handler", idx: i });
		// Fisher-Yates shuffle
		for (let i = ops.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[ops[i], ops[j]] = [ops[j], ops[i]];
		}

		const promises = new Array(n);
		for (const op of ops) {
			if (op.type === "deliver") {
				bridge.deliverResult({ content: [{ type: "text", text: `r${op.idx}` }] });
			} else {
				promises[op.idx] = bridge.waitForResult();
			}
			bridge.assertMutualExclusion();
		}

		const resolved = await Promise.all(promises);
		// All should resolve, queues should be empty
		assert.equal(resolved.length, n);
		assert.equal(bridge.handlersWaiting, 0);
		assert.equal(bridge.resultsQueued, 0);
	}
});
}

// --- Summary ---

console.log(`\nPassed: ${pass}  Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
