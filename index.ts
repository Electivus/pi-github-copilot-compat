// Run pi -e ./index.ts from this repository, or install the repository as a Pi package.
// Use /login github-copilot-compat. This reuses native Copilot login, including its model-policy setup.
// Models ending in -ws use Responses over WebSocket only. Sign in again to refresh an older catalog.
// The picker is gated; direct model lookups and local models.json overrides are not a security boundary.

import type {
	Api,
	Model,
	OAuthAuth,
	OAuthCredential,
	OpenAICompletionsOptions,
	Provider,
	ProviderHeaders,
	StreamOptions,
	ThinkingLevelMap,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { createProvider, hasApi } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copilotResponsesWebSocketFetch } from "./websocket.ts";

type CopilotApi = "openai-completions" | "openai-responses";

type CatalogRoutes = {
	chatCompletionsModelIds: string[];
	webSocketModelIds: string[];
	// Per model ID, the reasoning_effort values Copilot accepts on Chat Completions.
	reasoningEffortLevels: Record<string, string[]>;
};

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const id = "github-copilot-compat";
const name = "GitHub Copilot (Chat Completions / WebSocket)";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(createCopilotCompatProvider());
}

export function createCopilotCompatProvider(): Provider<CopilotApi> {
	const copilot = builtinProviders().find((provider) => provider.id === "github-copilot");
	const oauth = copilot?.auth.oauth;
	if (!copilot || !oauth) throw new Error("Built-in GitHub Copilot OAuth is unavailable");

	const catalog = copilot.getModels();
	const headers = { ...copilot.headers, ...catalog[0]?.headers };
	const completions = openAICompletionsApi();
	const responses = openAIResponsesApi();
	const wireIds = new Map<string, string>();
	const convertedIds = new Set<string>();
	const claudeIds = new Set<string>();
	// The levels of the credential last seen. A session resolves its model from the static catalog, which
	// cannot know them, so each request applies them here.
	let declared = new Map<string, ReadonlySet<string>>();
	const forRequest = <M extends Model<Api>>(model: M): M => {
		if (!convertedIds.has(model.id)) return model;
		const levels = declared.get(model.id);
		return levels ? withReasoningEffort(model, levels) : { ...model, reasoning: false };
	};
	const models = catalog.flatMap((model): Model<CopilotApi>[] => {
		if (!hasApi(model, "openai-completions")) convertedIds.add(model.id);
		if (hasApi(model, "anthropic-messages")) claudeIds.add(model.id);
		const chat = chatCompletionsModel(model);
		if (!hasApi(model, "openai-responses")) return [chat];
		const alias = `${model.id}-ws`;
		wireIds.set(alias, model.id);
		return [chat, { ...model, id: alias, provider: id, name: `${model.name} (WebSocket)` }];
	});
	const webSocketOptions = <T extends StreamOptions>(model: Model<Api>, context: TranscriptContext, options?: T) => {
		const wireId = wireIds.get(model.id);
		if (!wireId) throw new Error(`Unknown Copilot WebSocket model: ${model.id}`);
		return {
			...withCopilotHeaders(context, options),
			fetch: copilotResponsesWebSocketFetch(model.baseUrl, wireId, options?.websocketConnectTimeoutMs),
			maxRetries: 0,
		};
	};
	return createProvider<CopilotApi>({
		id,
		name,
		baseUrl: copilot.baseUrl,
		auth: {
			oauth: {
				...oauth,
				name,
				login: (interaction, options) =>
					withCatalog(() => oauth.login(interaction, options), oauth, headers, interaction.signal),
				refresh: (credential, signal) =>
					withCatalog(() => oauth.refresh(credential, signal), oauth, headers, signal),
				toAuth(credential) {
					const allowed = allowedRoutes(credential);
					if (allowed.chatCompletions.size === 0 && allowed.webSocket.size === 0) {
						throw new Error(
							"No verified Copilot Chat Completions or WebSocket models. Check access or sign in again.",
						);
					}
					declared = effortLevels(credential);
					return oauth.toAuth(credential);
				},
			},
		},
		models,
		filterModels(models, credential) {
			if (credential?.type !== "oauth" || credential.expires <= Date.now()) return [];
			const allowed = allowedRoutes(credential);
			declared = effortLevels(credential);
			return models.flatMap((model) => {
				if (hasApi(model, "openai-completions")) {
					return allowed.chatCompletions.has(model.id) ? [forRequest(model)] : [];
				}
				const wireId = wireIds.get(model.id);
				return wireId !== undefined && allowed.webSocket.has(wireId) ? [model] : [];
			});
		},
		api: {
			"openai-completions": {
				stream: (model, context, options) => {
					const request = forRequest(model);
					// The provider map types this entry for any API, but it only ever receives Chat Completions options.
					const completionsOptions: OpenAICompletionsOptions = withCopilotHeaders(
						context,
						claudeIds.has(model.id) ? withLongCache(options) : options,
					);
					completionsOptions.reasoningEffort = acceptedLevel(request, completionsOptions.reasoningEffort);
					return completions.stream(request, context, completionsOptions);
				},
				streamSimple: (model, context, options) => {
					const request = forRequest(model);
					return completions.streamSimple(request, context, {
						...withCopilotHeaders(context, claudeIds.has(model.id) ? withLongCache(options) : options),
						reasoning: acceptedLevel(request, options?.reasoning),
					});
				},
			},
			"openai-responses": {
				stream: (model, context, options) =>
					responses.stream(model, context, webSocketOptions(model, context, options)),
				streamSimple: (model, context, options) =>
					responses.streamSimple(model, context, webSocketOptions(model, context, options)),
			},
		},
	});
}

function chatCompletionsModel(model: Model<Api>): Model<"openai-completions"> {
	if (hasApi(model, "openai-completions")) return { ...model, provider: id };
	return {
		...model,
		api: "openai-completions",
		provider: id,
		// Measured on Copilot: a Claude prompt cache entry lasts five minutes, or one hour when the request asks.
		promptCache: hasApi(model, "anthropic-messages") ? { short: 300, long: 3600 } : undefined,
		compat: {
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
			supportsStore: false,
			supportsUsageInStreaming: false,
			supportsLongCacheRetention: false,
			maxTokensField: "max_tokens",
		},
	};
}

// Copilot rejects a reasoning_effort outside the levels it declares, so every other level is hidden.
function withReasoningEffort<M extends Model<Api>>(model: M, levels: ReadonlySet<string>): M {
	const thinkingLevelMap: ThinkingLevelMap = { off: levels.has("none") ? "none" : null };
	for (const level of EFFORT_LEVELS) thinkingLevelMap[level] = levels.has(level) ? level : null;
	return {
		...model,
		reasoning: true,
		thinkingLevelMap,
	};
}

// Pi sends a level the map hides as is, and Copilot answers that with a 400.
function acceptedLevel<L extends keyof ThinkingLevelMap>(model: Model<Api>, level: L | undefined): L | undefined {
	if (level === undefined || !model.reasoning) return undefined;
	return model.thinkingLevelMap?.[level] === null ? undefined : level;
}

// Copilot caches a Claude prompt for five minutes by itself. With long retention the request marks the system
// prompt and the last message, and Copilot keeps the prefix up to each mark for one hour, at the higher write price.
function withLongCache<T extends StreamOptions>(options: T | undefined) {
	const retention = options?.cacheRetention ?? options?.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION;
	if (retention !== "long") return options;
	const next = options?.onPayload;
	const onPayload: StreamOptions["onPayload"] = async (payload, model) => {
		markLongCache(payload);
		return next ? next(payload, model) : payload;
	};
	return { ...options, onPayload };
}

function markLongCache(payload: unknown): void {
	const messages = asRecord(payload)?.messages;
	if (!Array.isArray(messages)) return;
	const system = messages.find((message) => {
		const role = asRecord(message)?.role;
		return role === "system" || role === "developer";
	});
	for (const message of [system, messages.at(-1)]) {
		const record = asRecord(message);
		if (record) record.copilot_cache_control = { type: "ephemeral", ttl: "1h" };
	}
}

function withCopilotHeaders<T extends StreamOptions>(context: TranscriptContext, options?: T) {
	return { ...options, headers: { ...dynamicHeaders(context), ...options?.headers } };
}

async function withCatalog(
	getCredential: () => Promise<OAuthCredential>,
	oauth: OAuthAuth,
	headers: ProviderHeaders,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let credential: OAuthCredential;
	try {
		credential = await getCredential();
	} catch {
		signal.throwIfAborted();
		// The native OAuth error can include an upstream response body.
		throw new Error("GitHub Copilot OAuth failed");
	}

	let routes: CatalogRoutes = { chatCompletionsModelIds: [], webSocketModelIds: [], reasoningEffortLevels: {} };
	try {
		signal.throwIfAborted();
		const { baseUrl, apiKey, headers: authHeaders } = await oauth.toAuth(credential);
		if (baseUrl && apiKey) {
			const url = new URL(baseUrl);
			if (url.protocol === "https:" && url.href === `${url.origin}/`) {
				url.pathname = "/models";
				const response = await fetch(url, {
					headers: {
						...headers,
						...authHeaders,
						Accept: "application/json",
						Authorization: `Bearer ${apiKey}`,
						"X-GitHub-Api-Version": "2026-06-01",
					},
					redirect: "error",
					signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
				});
				if (response.ok) {
					routes = readCatalogRoutes(await response.json(), credential.availableModelIds);
				} else {
					await response.body?.cancel();
				}
			}
		}
	} catch {
		// Replace the previous allowlist even when discovery times out or fails.
	}
	signal.throwIfAborted();
	return { ...credential, ...routes };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function readCatalogRoutes(payload: unknown, availableModelIds: unknown): CatalogRoutes {
	const data = asRecord(payload)?.data;
	const chatCompletions = new Set<string>();
	const webSocket = new Set<string>();
	const efforts = new Map<string, string[]>();
	const available = new Set(stringList(availableModelIds));
	for (const raw of Array.isArray(data) ? data : []) {
		const item = asRecord(raw);
		if (!item || typeof item.id !== "string") continue;
		const supports = asRecord(asRecord(item.capabilities)?.supports);
		if (asRecord(item.policy)?.state === "disabled" || supports?.tool_calls === false) {
			// A contradictory duplicate cannot re-add a denied ID.
			available.delete(item.id);
			chatCompletions.delete(item.id);
			webSocket.delete(item.id);
			efforts.delete(item.id);
		} else if (available.has(item.id)) {
			const endpoints = stringList(item.supported_endpoints);
			if (endpoints.includes("/chat/completions")) {
				chatCompletions.add(item.id);
				const levels = stringList(supports?.reasoning_effort);
				if (levels.length > 0) efforts.set(item.id, [...levels]);
			}
			if (endpoints.includes("ws:/responses")) webSocket.add(item.id);
		}
	}
	return {
		chatCompletionsModelIds: [...chatCompletions],
		webSocketModelIds: [...webSocket],
		reasoningEffortLevels: Object.fromEntries(efforts),
	};
}

function effortLevels(credential: OAuthCredential): Map<string, ReadonlySet<string>> {
	const levels = new Map<string, ReadonlySet<string>>();
	for (const [modelId, value] of Object.entries(asRecord(credential.reasoningEffortLevels) ?? {})) {
		const declared = stringList(value);
		if (declared.length > 0) levels.set(modelId, new Set(declared));
	}
	return levels;
}

function allowedRoutes(credential: OAuthCredential) {
	const available = new Set(stringList(credential.availableModelIds));
	const select = (value: unknown) => new Set(stringList(value).filter((modelId) => available.has(modelId)));
	return {
		chatCompletions: select(credential.chatCompletionsModelIds),
		webSocket: select(credential.webSocketModelIds),
	};
}

function dynamicHeaders(context: TranscriptContext): ProviderHeaders {
	// The built-in adapter adds these only for github-copilot. Its helper is not an extension virtual module.
	const last = context.messages.at(-1);
	const hasImages = context.messages.some(
		(message) =>
			(message.role === "user" || message.role === "toolResult") &&
			Array.isArray(message.content) &&
			message.content.some((item) => item.type === "image"),
	);
	return {
		"X-Initiator": last && last.role !== "user" ? "agent" : "user",
		"Openai-Intent": "conversation-edits",
		...(hasImages ? { "Copilot-Vision-Request": "true" } : {}),
	};
}
