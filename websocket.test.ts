import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { copilotResponsesWebSocketFetch } from "./websocket.ts";

const base = "https://copilot.example.test";
const endpoint = `${base}/responses`;
const sdkBody = { model: "display-model", input: [{ role: "user", content: "Hello" }], stream: true };
const request: RequestInit = {
	method: "POST",
	headers: { "X-Initiator": "user" },
	body: JSON.stringify(sdkBody),
};

function mockTransport(t: TestContext) {
	const opened = Promise.withResolvers<MockSocket>();
	const sockets: MockSocket[] = [];
	class MockSocket extends EventTarget {
		readonly url: string;
		readonly headers: Headers;
		readonly sent: string[] = [];
		closed = false;

		constructor(url: string, options: { headers: Headers }) {
			super();
			this.url = url;
			this.headers = new Headers(options.headers);
			sockets.push(this);
			opened.resolve(this);
		}

		open() {
			this.dispatchEvent(new Event("open"));
		}

		send(frame: string) {
			this.sent.push(frame);
		}

		message(data: string) {
			this.dispatchEvent(new MessageEvent("message", { data }));
		}

		close() {
			this.closed = true;
			this.dispatchEvent(new Event("close"));
		}
	}

	const nativeSocket = globalThis.WebSocket;
	Object.defineProperty(globalThis, "WebSocket", { value: MockSocket });
	t.after(() => Object.defineProperty(globalThis, "WebSocket", { value: nativeSocket }));
	t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected HTTP request"));
	return { sockets, first: opened.promise };
}

test("opens a WebSocket with Copilot headers and reframes Responses messages as SSE", async (t) => {
	const { first, sockets } = mockTransport(t);
	const fetch = copilotResponsesWebSocketFetch(`${base}/`, "wire-model");
	const init = {
		method: "POST",
		headers: {
			Authorization: "Bearer example",
			"Copilot-Integration-Id": "vscode-chat",
			"Copilot-Vision-Request": "true",
			"OpenAI-Intent": "conversation-edits",
			"X-Initiator": "agent",
			"X-GitHub-Api-Version": "2025-01-01",
			Accept: "application/json",
			"Content-Type": "application/json",
			"Content-Length": "100",
			"Sec-WebSocket-Key": "not-a-handshake-key",
		},
		body: JSON.stringify({ ...sdkBody, type: "not-the-frame-type", previous_response_id: "stale", store: false }),
	};
	let resolved = false;
	const pending = fetch(endpoint, init).then((response) => {
		resolved = true;
		return response;
	});
	const socket = await first;
	await setImmediate();
	assert.equal(resolved, false);
	assert.deepEqual(socket.sent, []);
	assert.equal(socket.url, "wss://copilot.example.test/responses");
	for (const [name, expected] of Object.entries({
		authorization: "Bearer example",
		"copilot-integration-id": "vscode-chat",
		"copilot-vision-request": "true",
		"openai-intent": "conversation-edits",
		"x-initiator": "agent",
		"x-interaction-type": "conversation-edits",
		"x-github-api-version": "2025-05-01",
	})) {
		assert.equal(socket.headers.get(name), expected, name);
	}
	for (const name of ["accept", "content-type", "content-length", "sec-websocket-key"]) {
		assert.equal(socket.headers.has(name), false, name);
	}
	for (const name of ["x-request-id", "x-agent-task-id", "x-interaction-id"]) {
		assert.match(socket.headers.get(name) ?? "", /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i, name);
	}

	socket.open();
	const response = await pending;
	assert.equal(socket.sent.length, 1);
	assert.deepEqual(JSON.parse(socket.sent[0]), {
		type: "response.create",
		model: "wire-model",
		input: sdkBody.input,
		initiator: "agent",
		store: false,
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Content-Type"), "text/event-stream");
	const text = response.text();
	socket.message('{\n  "type": "response.output_text.delta",\n  "delta": "Olá\u00a0😊"\n}');
	assert.equal(socket.closed, false);
	socket.message('{"type":"response.completed","response":{"status":"completed"}}');
	assert.equal(
		await text,
		'data: {\ndata:   "type": "response.output_text.delta",\ndata:   "delta": "Olá\u00a0😊"\ndata: }\n\n' +
			'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
	);
	assert.equal(socket.closed, true);
	assert.equal(sockets.length, 1);
});

for (const type of ["response.incomplete", "response.failed"]) {
	test(`passes ${type} to Pi as a terminal event`, async (t) => {
		const { first } = mockTransport(t);
		const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
		const pending = fetch(new Request(endpoint, request));
		const socket = await first;
		socket.open();
		const response = await pending;
		assert.equal(JSON.parse(socket.sent[0]).initiator, "user");
		const frame = JSON.stringify({ type, response: { status: type.slice("response.".length) } });
		socket.message(frame);
		assert.equal(await response.text(), `data: ${frame}\n\n`);
		assert.equal(socket.closed, true);
	});
}

test("rejects unexpected URLs, methods, and malformed payloads before connecting", async (t) => {
	const { sockets } = mockTransport(t);
	for (const invalidBase of ["not a URL", "http://copilot.example.test", `${base}/v1`, `${base}/?q=1`]) {
		assert.throws(() => copilotResponsesWebSocketFetch(invalidBase, "wire-model"), /requires an HTTPS origin/);
	}
	const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
	for (const url of [
		"https://other.example.test/responses",
		"http://copilot.example.test/responses",
		`${endpoint}/`,
		`${endpoint}?`,
		`${endpoint}#fragment`,
		`${base}/v1/responses`,
	]) {
		await assert.rejects(fetch(url, request), /only handles POST/);
	}
	await assert.rejects(fetch(endpoint), /only handles POST/);
	await assert.rejects(fetch("not a URL", request), /Invalid Copilot WebSocket request/);
	await assert.rejects(fetch(endpoint, { ...request, body: "not JSON" }), /Invalid Copilot WebSocket request JSON/);
	await assert.rejects(fetch(endpoint, { ...request, body: "[]" }), /requires a streaming Responses request/);
	await assert.rejects(fetch(endpoint, { ...request, headers: {} }), /requires X-Initiator/);
	assert.equal(sockets.length, 0);
});

test("abort before connecting or before open never sends response.create", async (t) => {
	const { first, sockets } = mockTransport(t);
	const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
	await assert.rejects(fetch(endpoint, { ...request, signal: AbortSignal.abort() }), { name: "AbortError" });
	assert.equal(sockets.length, 0);

	const controller = new AbortController();
	const pending = fetch(endpoint, { ...request, signal: controller.signal });
	const socket = await first;
	controller.abort();
	socket.open();
	await assert.rejects(pending, { name: "AbortError" });
	assert.deepEqual(socket.sent, []);
	assert.equal(socket.closed, true);
});

test("abort after open errors the body and closes the socket", async (t) => {
	const { first } = mockTransport(t);
	const controller = new AbortController();
	const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
	const pending = fetch(endpoint, { ...request, signal: controller.signal });
	const socket = await first;
	socket.open();
	const response = await pending;
	const rejected = assert.rejects(response.text(), { name: "AbortError" });
	controller.abort();
	await rejected;
	assert.equal(socket.closed, true);
});

test("cancelling the response reader closes the socket", async (t) => {
	const { first } = mockTransport(t);
	const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
	const pending = fetch(endpoint, request);
	const socket = await first;
	socket.open();
	const response = await pending;
	assert.ok(response.body);
	await response.body.getReader().cancel();
	assert.equal(socket.closed, true);
});

test("a rejected handshake does not create a response or fall back to HTTP", async (t) => {
	const { first, sockets } = mockTransport(t);
	const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
	const pending = fetch(endpoint, request);
	const socket = await first;
	socket.dispatchEvent(new Event("error"));
	await assert.rejects(pending, /Copilot WebSocket network error/);
	assert.deepEqual(socket.sent, []);
	assert.equal(socket.closed, true);
	assert.equal(sockets.length, 1);
});

for (const [description, event, expected] of [
	["premature close", new Event("close"), "Copilot WebSocket closed before a terminal response"],
	["network failure", new Event("error"), "Copilot WebSocket network error"],
	[
		"protocol error",
		new MessageEvent("message", { data: '{"type":"error","message":"private"}' }),
		"Copilot WebSocket returned a protocol error",
	],
	[
		"invalid JSON",
		new MessageEvent("message", { data: '{"payload":"private"' }),
		"Invalid Copilot WebSocket response frame",
	],
] as const) {
	test(`${description} fails the response body without reconnecting`, async (t) => {
		const { first, sockets } = mockTransport(t);
		const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
		const pending = fetch(endpoint, request);
		const socket = await first;
		socket.open();
		const response = await pending;
		const rejected = assert.rejects(response.text(), { message: expected });
		socket.dispatchEvent(event);
		await rejected;
		assert.equal(socket.closed, true);
		assert.equal(sockets.length, 1);
	});
}

test("the default timeout applies only while connecting", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { first } = mockTransport(t);
	const fetch = copilotResponsesWebSocketFetch(base, "wire-model");
	const pending = fetch(endpoint, request);
	const socket = await first;
	const rejected = assert.rejects(pending, /handshake timed out/);
	t.mock.timers.tick(14_999);
	assert.equal(socket.closed, false);
	t.mock.timers.tick(1);
	await rejected;
	assert.equal(socket.closed, true);
});

for (const timeout of [0, 1]) {
	test(`timeout ${timeout} does not run during streaming`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { first } = mockTransport(t);
		const fetch = copilotResponsesWebSocketFetch(base, "wire-model", timeout);
		const pending = fetch(endpoint, request);
		const socket = await first;
		if (timeout === 0) t.mock.timers.tick(60_000);
		socket.open();
		const response = await pending;
		t.mock.timers.tick(60_000);
		assert.equal(socket.closed, false);
		socket.message('{"type":"response.completed"}');
		assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n');
	});
}
