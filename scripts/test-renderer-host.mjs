import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const hostRoot = resolve(process.env.PI_TEST_HOST_PACKAGE ?? "node_modules/@earendil-works/pi-coding-agent");
process.env.PI_PACKAGE_DIR = hostRoot;
const entry = existsSync(join(hostRoot, "dist/bundle/index.js")) ? "dist/bundle/index.js" : "dist/index.js";
const host = await import(pathToFileURL(join(hostRoot, entry)).href);
host.initTheme("dark", true);
const root = await mkdtemp(join(tmpdir(), "thinking-renderer-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const original = host.AssistantMessageComponent.prototype.updateContent;
let extension;
let ctx;
try {
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const loaded = await host.discoverAndLoadExtensions([resolve("index.ts")], root, agentDir);
	assert.deepEqual(loaded.errors, []);
	extension = loaded.extensions.find((item) => item.commands.has("thinking-steps"));
	assert.ok(extension);
	const notices = [];
	ctx = {
		cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: host.SessionManager.create(root, root),
		ui: { theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text }, notify: (message, level) => notices.push({ message, level }), setStatus() {}, setHiddenThinkingLabel() {} },
	};
	loaded.runtime.appendEntry = (name, data) => ctx.sessionManager.appendCustomEntry(name, data);
	for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.deepEqual(notices.filter((notice) => notice.level === "warning"), []);
	const input = {
		role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "stop",
		content: [{ type: "thinking", thinking: "Check two plus two." }, { type: "text", text: "Four." }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const contexts = [];
	const transform = (text, context) => { contexts.push(context); return text; };
	const component = new host.AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [transform], "fixture-entry", "2026-11-04T12:00:00.000Z");
	const output = () => component.render(80).map(stripVTControlCharacters).join("\n");
	component.updateContent(input, true);
	assert.match(output(), /Check two plus two/);
	assert.match(output(), /Four\./);
	assert.equal(contexts.at(-1).isStreaming, true);
	const textMarkdown = component.markdownSlots?.find((slot) => slot.kind === "text")?.markdown;
	component.updateContent(input, false);
	assert.match(output(), /Four\./);
	assert.equal(contexts.at(-1).isStreaming, false);
	const [major, minor] = host.VERSION.split(".").map(Number);
	if (major > 1 || (major === 1 && minor >= 5)) {
		assert.ok(textMarkdown, "Pi 1.5 must retain its text Markdown slot");
		assert.equal(component.markdownSlots.find((slot) => slot.kind === "text").markdown, textMarkdown);
		assert.equal(contexts.at(-1).messageId, "fixture-entry");
		assert.equal(contexts.at(-1).timestamp, "2026-11-04T12:00:00.000Z");
	}
	const noThinking = { ...input, content: [{ type: "text", text: "Four." }] };
	component.updateContent(noThinking, true);
	assert.match(output(), /Waiting for thinking content/);
	component.updateContent(noThinking, false);
	assert.match(output(), /No thinking content supplied/);
	assert.doesNotMatch(output(), /Waiting for thinking content/);
	component.setHiddenThinkingLabel("");
	component.setHideThinkingBlock(true);
	component.updateContent(input, false);
	const hidden = output();
	const native = new host.AssistantMessageComponent(undefined, true, undefined, "");
	original.call(native, noThinking, false);
	assert.equal(hidden, native.render(80).map(stripVTControlCharacters).join("\n"));
	assert.equal(component.lastMessage, input);
	console.log(`Renderer host ${host.VERSION}: thinking, no-thinking, stream end, hidden spacing, and transformer context passed.`);
} finally {
	try {
		if (extension && ctx) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		assert.equal(host.AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
}
