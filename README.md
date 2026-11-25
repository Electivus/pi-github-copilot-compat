# pi-github-copilot-compat

A [Pi](https://github.com/earendil-works/pi) extension that registers the provider `github-copilot-compat`. It reaches GitHub Copilot models over two transports that Pi's built-in `github-copilot` provider does not use:

- **Chat Completions**: every model of the Copilot catalog, called on `/chat/completions`.
- **Responses over WebSocket**: for each model that speaks the Responses API, a second model with the suffix `-ws`. It uses the WebSocket only and never falls back to HTTP.

It exists for networks where the built-in provider's transports are blocked or disabled and these two still work.

This is an independent project. It is not affiliated with, endorsed by, or supported by GitHub or the Pi maintainers. It calls the same Copilot endpoints the built-in provider calls, with your own Copilot subscription, and your use of Copilot stays under GitHub's terms.

## Install

Requires Pi 1.6.0 or newer.

```bash
pi install git:github.com/Electivus/pi-github-copilot-compat
```

To try it from a clone without installing:

```bash
pi -e ./index.ts
```

Then, inside Pi:

```
/login github-copilot-compat
```

The login is Pi's own GitHub Copilot OAuth flow, including its model-policy setup. The credential is stored under this provider's name, separate from the built-in provider's.

## How it works

After every login and every token refresh, the extension reads Copilot's `/models` catalog once and stores three things with the credential:

- which models advertise `/chat/completions`;
- which models advertise `ws:/responses`;
- which `reasoning_effort` values each Chat Completions model accepts.

The model picker lists only the models that catalog confirmed. A model that a policy disables, or that does not support tool calls, is left out. If the catalog cannot be read, the previous lists are dropped and no model is offered until a refresh or a login reads it again.

That filter applies to the picker. A direct model lookup or a local `models.json` override goes around it, so it is not a security boundary.

### Reasoning effort

A Claude model on Chat Completions takes a top-level `reasoning_effort`, and Copilot rejects a value outside the levels it declares for that model with a 400. The extension therefore:

- lists thinking levels in the model picker only for models whose catalog entry declares them;
- sends the level you pick as `reasoning_effort`;
- sends no `reasoning_effort` when the level is not declared, or when the model declares none. The level is dropped, not rounded to the nearest declared one.

A running session can still show a level the model does not declare, because Pi resolves a session's model from the built-in catalog. The request is corrected either way.

This applies to the models the extension converts to Chat Completions, such as Claude. A model the Copilot catalog already serves on Chat Completions, such as Gemini, keeps the thinking levels of Pi's built-in catalog.

A credential created before version 0.2.0 has no levels stored. They appear after the next token refresh, or after signing in again.

Copilot does not return the reasoning text for every model, so Pi may show no thinking block even though the model reasoned and the tokens were counted.

### Context size

Copilot prices some models in two tiers: a request whose prompt passes the first tier's limit is billed at a higher rate, for the whole request. On GPT-6.1 Sol that limit is 272,000 tokens and the rate doubles; on Claude Haiku 5.5 it is 100,000 tokens and the rate is five times higher.

For such a model the extension lists two entries, as VS Code's context size picker does:

- the plain model, whose context window is the first tier's limit, so Pi compacts before a request reaches the higher rate;
- the same model with the suffix `-long`, with the whole window.

A model with one price for its whole window, such as Claude Opus 5.5, has a single entry with the whole window. The limits come from the price tiers in Pi's built-in catalog.


Copilot caches a Claude prompt by itself for five minutes, on Chat Completions as on the Messages API. A session that pauses longer, for example while subagents work, pays to write the whole context again.

With long cache retention (`PI_CACHE_RETENTION=long`), the extension marks the system prompt and the last message of each Claude request with `copilot_cache_control: { "type": "ephemeral", "ttl": "1h" }`. Copilot then keeps the prefix up to each mark for one hour.

Measured on a Copilot Business account in November 2026:

| Cache write | Price against the input price |
| --- | --- |
| Five minutes (default) | 1.25x |
| One hour | 2x |

So long retention costs more per write and pays off when a session has pauses over five minutes. `ttl` is not documented for Chat Completions; Copilot accepted and billed it when measured, and that can change.

Converted Claude models also declare these two lifetimes, which makes them eligible for Pi's cache warming under any retention. Pi's `cacheWarming` setting is `"idle"` by default, so warming is on unless you turn it off. Each warm repeats the last request with a one-token output cap; when measured, that request read the whole prompt from the cache, so it is billed at the cache-read price plus one output token.

## Development

Requires Node.js 24 or newer.

```bash
npm ci --ignore-scripts
npm run check
npm test
```

The tests use fake credentials and replace `fetch` and `WebSocket`; an unexpected request fails the test.

| File | Contents |
| --- | --- |
| `index.ts` | The provider, the login with catalog discovery, the model filter and the reasoning-effort mapping |
| `websocket.ts` | A `fetch` that sends a Responses request over a WebSocket and returns the frames as server-sent events |
| `test.ts`, `websocket.test.ts` | Their tests |

## Repository settings

`scripts/configure-repository.sh` applies the settings this repository relies on through the GitHub CLI: squash-only merges, rulesets for `main` and `v*` tags, read-only and SHA-pinned Actions, secret scanning with push protection, and Dependabot alerts and fixes. It needs repository admin rights.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

[MIT](LICENSE)
