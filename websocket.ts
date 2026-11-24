import { randomUUID } from "node:crypto";

const HTTP_ONLY_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"expect",
	"host",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export function copilotResponsesWebSocketFetch(
	baseUrl: string,
	wireModelId: string,
	connectTimeoutMs = 15_000,
): typeof globalThis.fetch {
	const base = URL.parse(baseUrl);
	if (!base || base.protocol !== "https:" || base.href !== `${base.origin}/`) {
		throw new Error("Copilot WebSocket requires an HTTPS origin as its base URL");
	}
	const responsesUrl = `${base.origin}/responses`;
	const socketUrl = `wss://${base.host}/responses`;

	return async (input, init) => {
		let request: Request;
		try {
			request = new Request(input, init);
		} catch {
			throw new Error("Invalid Copilot WebSocket request");
		}
		if (request.method !== "POST" || request.url !== responsesUrl) {
			throw new Error("Copilot WebSocket only handles POST to the configured /responses endpoint");
		}
		const { signal } = request;
		if (signal.aborted) throw abortError();

		const initiator = request.headers.get("x-initiator");
		if (initiator !== "agent" && initiator !== "user") {
			throw new Error("Copilot WebSocket request requires X-Initiator: agent or user");
		}
		let payload: unknown;
		try {
			payload = await request.json();
		} catch {
			throw new Error("Invalid Copilot WebSocket request JSON");
		}
		if (signal.aborted) throw abortError();
		if (!isJsonObject(payload) || payload.stream !== true || typeof payload.model !== "string") {
			throw new Error("Copilot WebSocket requires a streaming Responses request");
		}
		delete payload.stream;
		delete payload.previous_response_id;
		const frame = JSON.stringify({ ...payload, type: "response.create", model: wireModelId, initiator });

		const headers = new Headers(request.headers);
		for (const name of HTTP_ONLY_HEADERS) headers.delete(name);
		for (const [name] of request.headers) {
			if (name.startsWith("sec-websocket-")) headers.delete(name);
		}
		headers.set("X-GitHub-Api-Version", "2025-05-01");
		headers.set("OpenAI-Intent", "conversation-edits");
		headers.set("X-Interaction-Type", "conversation-edits");
		headers.set("X-Request-Id", randomUUID());
		headers.set("X-Agent-Task-Id", randomUUID());
		headers.set("X-Interaction-Id", randomUUID());

		return streamSocket(socketUrl, headers, frame, signal, connectTimeoutMs);
	};
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError(): DOMException {
	return new DOMException("Copilot WebSocket request aborted", "AbortError");
}

function streamSocket(
	url: string,
	headers: Headers,
	frame: string,
	signal: AbortSignal,
	connectTimeoutMs: number,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		let socket: WebSocket;
		try {
			// Node supports handshake headers, but the DOM constructor type does not expose them.
			const NodeWebSocket = WebSocket as typeof WebSocket & {
				new (url: string, options: { headers: Headers }): WebSocket;
			};
			socket = new NodeWebSocket(url, { headers });
		} catch {
			reject(new Error("Could not create Copilot WebSocket"));
			return;
		}

		let state:
			| { kind: "connecting" }
			| { kind: "streaming"; controller: ReadableStreamDefaultController<Uint8Array> }
			| { kind: "finished" } = { kind: "connecting" };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const encoder = new TextEncoder();

		function stop() {
			state = { kind: "finished" };
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			socket.close();
		}

		function fail(error: Error) {
			const previous = state;
			stop();
			if (previous.kind === "connecting") reject(error);
			if (previous.kind === "streaming") previous.controller.error(error);
		}

		function onOpen() {
			if (signal.aborted) {
				onAbort();
				return;
			}
			clearTimeout(timer);
			try {
				socket.send(frame);
			} catch {
				fail(new Error("Could not send Copilot WebSocket request"));
				return;
			}
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					state = { kind: "streaming", controller };
				},
				cancel: stop,
			});
			resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
		}

		function onMessage(event: MessageEvent) {
			if (state.kind !== "streaming") return;
			const text: unknown = event.data;
			let message: unknown;
			try {
				if (typeof text === "string") message = JSON.parse(text);
			} catch {
				// Report malformed frames without exposing the provider payload.
			}
			if (!isJsonObject(message) || typeof message.type !== "string" || typeof text !== "string") {
				fail(new Error("Invalid Copilot WebSocket response frame"));
				return;
			}
			if (message.type === "error") {
				fail(new Error("Copilot WebSocket returned a protocol error"));
				return;
			}
			state.controller.enqueue(encoder.encode(`data: ${text.replace(/\r\n|\r|\n/g, "\ndata: ")}\n\n`));
			switch (message.type) {
				case "response.completed":
				case "response.incomplete":
				case "response.failed":
					state.controller.close();
					stop();
			}
		}

		function onAbort() {
			fail(abortError());
		}

		function onError() {
			fail(new Error("Copilot WebSocket network error"));
		}

		function onClose() {
			fail(new Error("Copilot WebSocket closed before a terminal response"));
		}

		socket.addEventListener("open", onOpen, { once: true });
		socket.addEventListener("message", onMessage);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal.addEventListener("abort", onAbort, { once: true });
		if (connectTimeoutMs > 0) {
			timer = setTimeout(() => fail(new Error("Copilot WebSocket handshake timed out")), connectTimeoutMs);
		}
	});
}
