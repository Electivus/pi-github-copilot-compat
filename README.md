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

- offers thinking levels only on models whose catalog entry declares them;
- sends the level you pick as `reasoning_effort`;
- sends no `reasoning_effort` when the level is not declared, or when the model declares none.

A credential created before version 0.2.0 has no levels stored. They appear after the next token refresh, or after signing in again.

Copilot does not return the reasoning text for every model, so Pi may show no thinking block even though the model reasoned and the tokens were counted.

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

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

[MIT](LICENSE)
