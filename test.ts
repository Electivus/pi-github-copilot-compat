import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Context,
	createModels,
	InMemoryCredentialStore,
	ModelsError,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createCopilotCompatProvider } from "./index.ts";

const claude = "claude-sonnet-4.6";
const gemini = "gemini-3.8-flash";
const responsesOnly = "gpt-5.3-codex";
const websocketOnly = "gpt-6-astra";
const websocketAlias = `${websocketOnly}-ws`;
const disabled = "claude-opus-4.8";
const noTools = "claude-haiku-4.5";
const nearMatch = "claude-fable-5";
const unlisted = "gemini-4-argon";
const noAdvertisement = "gemini-4-carbon";
const catalogHost = "api.business.githubcopilot.test";
const token = `tid=fake;proxy-ep=${catalogHost.replace("api.", "proxy.")};`;
const modelPath = "/chat/completions";

type FetchInput = Parameters<typeof fetch>[0];

function fakeCredential(overrides?: Partial<OAuthCredential>): OAuthCredential {
	return {
		type: "oauth",
		access: token,
		refresh: "fake-github-token",
		expires: Date.now() + 60 * 60 * 1000,
		availableModelIds: [claude, gemini, responsesOnly],
		chatCompletionsModelIds: [claude, gemini],
		...overrides,
	};
}

function setup() {
	const provider = createCopilotCompatProvider();
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	models.setProvider(provider);
	return { provider, credentials, models };
}

function modelEntry(id: string, supported_endpoints?: string[]) {
	return { id, supported_endpoints, model_picker_enabled: true, policy: { state: "enabled" } };
}

const tokenResponse = (access: string) => Response.json({ token: access, expires_at: Date.now() / 1_000 + 7_200 });

function catalogResponse(...data: unknown[]) {
	return Response.json({ data });
}

test("native enterprise OAuth login gates exact advertised endpoints and keeps credentials separate", async (t) => {
	const { provider, credentials, models } = setup();
	const native = builtinProviders().find((entry) => entry.id === "github-copilot");
	assert.ok(native);
	models.setProvider(native);
	await credentials.modify(native.id, async () => fakeCredential({ availableModelIds: [responsesOnly] }));
	assert.deepEqual(await models.getAvailable(provider.id), []);
	assert.equal(provider.auth.apiKey, undefined);
	const snapshot = [claude, gemini, responsesOnly, websocketOnly, disabled, noTools, nearMatch, noAdvertisement];
	const transport = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: RequestInit) => {
		const request = new Request(input, init);
		switch (request.url) {
			case "https://approved.ghe.test/login/device/code":
				return Response.json({
					device_code: "fake-device",
					user_code: "fake-code",
					verification_uri: "https://approved.ghe.test/login/device",
					interval: 1,
					expires_in: 60,
				});
			case "https://approved.ghe.test/login/oauth/access_token":
				assert.equal((await request.formData()).get("device_code"), "fake-device");
				return Response.json({ access_token: "fake-github-token" });
			case "https://api.approved.ghe.test/copilot_internal/v2/token":
				assert.equal(request.headers.get("Authorization"), "Bearer fake-github-token");
				return tokenResponse(token);
			case `https://${catalogHost}/models`:
				assert.equal(request.method, "GET");
				assert.equal(request.headers.get("Authorization"), `Bearer ${token}`);
				if (request.redirect !== "error") return catalogResponse(...snapshot.map((id) => modelEntry(id)));
				assert.ok(init?.signal);
				assert.equal(request.headers.get("Editor-Version"), native.getModels()[0]?.headers?.["Editor-Version"]);
				return catalogResponse(
					{
						...modelEntry(claude, ["/v1/messages", modelPath]),
						capabilities: { supports: { reasoning_effort: ["low", "high", "max"] } },
					},
					{ ...modelEntry(gemini, [modelPath]), capabilities: { supports: { reasoning_effort: ["low"] } } },
					{
						...modelEntry(websocketOnly, ["ws:/responses"]),
						capabilities: { supports: { reasoning_effort: ["low"] } },
					},
					modelEntry(responsesOnly, ["/responses"]),
					modelEntry(websocketOnly, ["ws:/responses"]),
					modelEntry(disabled, [modelPath, "ws:/responses"]),
					{ ...modelEntry(disabled, [modelPath, "ws:/responses"]), policy: { state: "disabled" } },
					{ ...modelEntry(noTools, [modelPath]), capabilities: { supports: { tool_calls: false } } },
					modelEntry(nearMatch, ["/chat/completions/"]),
					modelEntry(unlisted, [modelPath]),
					modelEntry(noAdvertisement),
				);
			default:
				assert.fail(`Unexpected fake request to ${request.url}`);
		}
	});
	const result = await models.login(provider.id, "oauth", {
		prompt: async () => "approved.ghe.test",
		notify: () => {},
	});
	assert.equal(transport.mock.callCount(), 5);
	assert.equal(result.type, "oauth");
	assert.deepEqual(result.chatCompletionsModelIds, [claude, gemini]);
	assert.deepEqual(result.webSocketModelIds, [websocketOnly]);
	assert.deepEqual(result.reasoningEffortLevels, { [claude]: ["low", "high", "max"], [gemini]: ["low"] });
	assert.deepEqual(result.availableModelIds, snapshot);
	assert.equal(result.enterpriseUrl, "approved.ghe.test");
	const available = await models.getAvailable(provider.id);
	assert.deepEqual(available.map(({ id, api }) => [id, api]).sort(), [
		[claude, "openai-completions"],
		[gemini, "openai-completions"],
		[websocketAlias, "openai-responses"],
	]);
	assert.ok(available.every((model) => model.provider === provider.id));
	assert.equal(models.getModel(provider.id, websocketAlias)?.api, "openai-responses");
	const converted = available.find(({ id }) => id === claude);
	assert.equal(converted?.reasoning, true);
	assert.deepEqual(converted?.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
	const nativeGemini = native.getModels().find(({ id }) => id === gemini);
	const compatGemini = available.find(({ id }) => id === gemini);
	assert.deepEqual(compatGemini?.compat, nativeGemini?.compat);
	assert.deepEqual(compatGemini?.thinkingLevelMap, nativeGemini?.thinkingLevelMap);
	assert.deepEqual(
		(await models.getAvailable(native.id)).map(({ id }) => id),
		[responsesOnly],
	);
});

test("refresh replaces the allowlist and drops it on metadata failure", async (t) => {
	const { provider, credentials, models } = setup();
	const refreshedHost = "api.enterprise.githubcopilot.test";
	const refreshedToken = "tid=renewed-fake;proxy-ep=proxy.enterprise.githubcopilot.test;";
	let discoveryDenied = false;
	let tokenDenied = false;
	let discoveryRequests = 0;
	t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.url === "https://api.approved.ghe.test/copilot_internal/v2/token") {
			assert.equal(request.headers.get("Authorization"), "Bearer fake-github-token");
			return tokenDenied ? new Response("private fake token error", { status: 403 }) : tokenResponse(refreshedToken);
		}
		assert.equal(request.url, `https://${refreshedHost}/models`);
		assert.equal(request.headers.get("Authorization"), `Bearer ${refreshedToken}`);
		if (request.redirect !== "error") return catalogResponse(modelEntry(claude), modelEntry(gemini));
		discoveryRequests++;
		return discoveryDenied
			? new Response("private fake failure text", { status: 403 })
			: catalogResponse(modelEntry(gemini, [modelPath]));
	});
	await credentials.modify(provider.id, async () =>
		fakeCredential({ enterpriseUrl: "approved.ghe.test", expires: 0 }),
	);
	assert.deepEqual(await models.getAvailable(provider.id), []);
	assert.equal((await models.getAuth(provider.id))?.auth.baseUrl, `https://${refreshedHost}`);
	assert.deepEqual(
		(await models.getAvailable(provider.id)).map(({ id }) => id),
		[gemini],
	);

	discoveryDenied = true;
	await credentials.modify(provider.id, async () =>
		fakeCredential({ enterpriseUrl: "approved.ghe.test", expires: 0, webSocketModelIds: [websocketOnly] }),
	);
	await assert.rejects(models.getAuth(provider.id), { code: "oauth" });
	assert.equal(discoveryRequests, 2);
	assert.deepEqual(await models.getAvailable(provider.id), []);
	const stored = await credentials.read(provider.id);
	assert.equal(stored?.type, "oauth");
	assert.equal(stored.access, refreshedToken);
	assert.deepEqual(stored.chatCompletionsModelIds, []);
	assert.deepEqual(stored.webSocketModelIds, []);
	assert.deepEqual(stored.availableModelIds, [claude, gemini]);

	tokenDenied = true;
	await credentials.modify(provider.id, async () =>
		fakeCredential({ enterpriseUrl: "approved.ghe.test", expires: 0 }),
	);
	await assert.rejects(models.getAuth(provider.id), (error: unknown) => {
		assert.ok(error instanceof ModelsError);
		assert.equal(error.code, "oauth");
		assert.doesNotMatch(error.message, /private fake token error/);
		assert.ok(error.cause instanceof Error);
		assert.doesNotMatch(error.cause.message, /private fake token error/);
		return true;
	});
	assert.equal(discoveryRequests, 2);
	assert.deepEqual(await models.getAvailable(provider.id), []);
});

test("catalog discovery honors OAuth cancellation", async (t) => {
	const oauth = createCopilotCompatProvider().auth.oauth;
	assert.ok(oauth);
	const controller = new AbortController();
	const reason = new Error("cancelled fake refresh");
	const fetch = t.mock.method(globalThis, "fetch", async (input: FetchInput, init?: RequestInit) => {
		const request = new Request(input, init);
		if (request.url === "https://api.github.com/copilot_internal/v2/token") return tokenResponse(token);
		assert.equal(request.url, `https://${catalogHost}/models`);
		if (request.redirect !== "error") return catalogResponse(modelEntry(claude));
		controller.abort(reason);
		assert.equal(request.signal.reason, reason);
		request.signal.throwIfAborted();
		return catalogResponse(modelEntry(claude, [modelPath]));
	});
	await assert.rejects(oauth.refresh(fakeCredential(), controller.signal), reason);
	assert.equal(fetch.mock.callCount(), 3);
});

test("missing or malformed catalog metadata cannot grant access", async () => {
	const { provider, credentials, models } = setup();
	for (const metadata of [undefined, [claude, 123], [responsesOnly]]) {
		await credentials.modify(provider.id, async () =>
			fakeCredential({ availableModelIds: [claude], chatCompletionsModelIds: metadata }),
		);
		assert.deepEqual(await models.getAvailable(provider.id), []);
		await assert.rejects(models.getAuth(provider.id), { code: "oauth" });
	}
});

test("sends Claude to Chat Completions with Copilot headers and does not fall back after 403", async () => {
	const { provider, credentials, models } = setup();
	await credentials.modify(provider.id, async () => fakeCredential());
	const model = (await models.getAvailable(provider.id)).find(({ id }) => id === claude);
	assert.ok(model);
	const context: Context = {
		messages: [
			{
				role: "user",
				timestamp: 0,
				content: [
					{ type: "text", text: "Describe the image" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
			},
		],
	};
	const requests: Request[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		assert.equal(request.url, `https://${catalogHost}/chat/completions`);
		assert.equal(request.method, "POST");
		assert.equal(request.headers.get("Authorization"), `Bearer ${token}`);
		assert.equal(request.headers.get("X-Initiator"), "user");
		assert.equal(request.headers.get("Openai-Intent"), "conversation-edits");
		assert.equal(request.headers.get("Copilot-Vision-Request"), "true");
		assert.ok(request.headers.has("Copilot-Integration-Id"));
		const payload = await request.json();
		assert.ok(payload && typeof payload === "object");
		assert.partialDeepStrictEqual(payload, { model: claude, stream: true, max_tokens: 16 });
		assert.ok(!("store" in payload));
		assert.ok(!("reasoning_effort" in payload));
		if (requests.length > 1) return new Response("Denied", { status: 403 });
		const chunk = { id: "fake-chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	};
	const complete = await models.completeSimple(model, context, { fetch, maxTokens: 16 });
	assert.equal(complete.stopReason, "stop");
	assert.equal(complete.provider, provider.id);
	assert.deepEqual(complete.content, [{ type: "text", text: "ok" }]);
	const denied = await models.complete(model, context, { fetch, maxTokens: 16 });
	assert.equal(denied.stopReason, "error");
	assert.match(denied.errorMessage ?? "", /403/);
	assert.equal(denied.provider, provider.id);
	assert.equal(requests.length, 2);
});

test("a converted model sends only the reasoning effort Copilot declared for it", async () => {
	const { provider, credentials, models } = setup();
	await credentials.modify(provider.id, async () =>
		fakeCredential({ reasoningEffortLevels: { [claude]: ["low", "high"], [disabled]: ["high"] } }),
	);
	const available = await models.getAvailable(provider.id);
	const model = available.find(({ id }) => id === claude);
	assert.ok(model);
	assert.equal(model.reasoning, true);
	assert.ok(!available.some(({ id }) => id === disabled));
	const efforts: unknown[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const payload: unknown = await new Request(input, init).json();
		assert.ok(payload && typeof payload === "object");
		efforts.push("reasoning_effort" in payload ? payload.reasoning_effort : undefined);
		const chunk = { id: "fake-chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			headers: { "Content-Type": "text/event-stream" },
		});
	};
	const context: Context = { messages: [{ role: "user", timestamp: 0, content: "Hello" }] };
	// A session resolves its model from the static catalog, not from the credential's list.
	const sessionModel = models.getModel(provider.id, claude);
	assert.ok(sessionModel);
	await models.completeSimple(sessionModel, context, { fetch, reasoning: "high" });
	await models.completeSimple(sessionModel, context, { fetch, reasoning: "max" });
	await models.completeSimple(sessionModel, context, { fetch });
	assert.deepEqual(efforts, ["high", undefined, undefined]);

	await credentials.modify(provider.id, async () => fakeCredential({ reasoningEffortLevels: { [claude]: [] } }));
	assert.equal((await models.getAvailable(provider.id)).find(({ id }) => id === claude)?.reasoning, false);
	await models.completeSimple(sessionModel, context, { fetch, reasoning: "high" });
	assert.deepEqual(efforts, ["high", undefined, undefined, undefined]);
});

test("a WebSocket model sends its wire ID, streams tools, and never uses HTTP", async (t) => {
	const { provider, credentials, models } = setup();
	await credentials.modify(provider.id, async () =>
		fakeCredential({
			availableModelIds: [websocketOnly],
			chatCompletionsModelIds: [],
			webSocketModelIds: [websocketOnly],
		}),
	);
	const [model] = await models.getAvailable(provider.id);
	assert.equal(model.id, websocketAlias);

	const tool = {
		type: "function_call",
		id: "fc_fixture",
		call_id: "call_fixture",
		name: "look_up",
		arguments: '{"name":"test"}',
	};
	let connected = 0;
	let sent = 0;
	let closeBeforeCompletion = false;
	class FixtureSocket extends EventTarget {
		private closed = false;

		constructor(url: string | URL, options: { headers: HeadersInit }) {
			super();
			connected++;
			assert.equal(String(url), `wss://${catalogHost}/responses`);
			assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${token}`);
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}

		send(frame: string) {
			sent++;
			const body = JSON.parse(frame);
			assert.partialDeepStrictEqual(body, { type: "response.create", model: websocketOnly, initiator: "user" });
			assert.ok(body.stream === undefined);
			queueMicrotask(() => {
				if (closeBeforeCompletion) {
					this.close();
					return;
				}
				for (const event of [
					{ type: "response.output_item.done", output_index: 0, item: tool },
					{ type: "response.completed", response: { status: "completed", output: [tool] } },
				]) {
					this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
				}
			});
		}

		close() {
			if (this.closed) return;
			this.closed = true;
			this.dispatchEvent(new Event("close"));
		}
	}
	// Substitute only the socket boundary. Both the Pi Responses adapter and provider dispatch run normally.
	const nativeSocket = globalThis.WebSocket;
	Object.defineProperty(globalThis, "WebSocket", { value: FixtureSocket });
	t.after(() => Object.defineProperty(globalThis, "WebSocket", { value: nativeSocket }));
	const fetch = t.mock.fn<typeof globalThis.fetch>(() => Promise.reject(new Error("Unexpected HTTPS request")));
	const context: Context = {
		messages: [{ role: "user", content: "Use the tool", timestamp: 0 }],
		tools: [
			{
				name: "look_up",
				description: "Use the fixture name",
				parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			},
		],
	};
	const signal = AbortSignal.timeout(5_000);
	const complete = await models.completeSimple(model, context, { fetch, signal });
	assert.equal(complete.stopReason, "toolUse", complete.errorMessage ?? "unexpected stop reason");
	assert.equal(complete.provider, provider.id);
	assert.equal(complete.model, websocketAlias);
	assert.partialDeepStrictEqual(complete.content, [
		{ type: "toolCall", name: "look_up", arguments: { name: "test" } },
	]);
	closeBeforeCompletion = true;
	const failed = await models.complete(model, context, { fetch, signal, maxRetries: 2 });
	assert.equal(failed.stopReason, "error");
	assert.equal(sent, 2);
	assert.equal(connected, 2);
	assert.equal(fetch.mock.callCount(), 0);
});
