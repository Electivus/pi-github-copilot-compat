# pi-github-copilot-compat

Extensão do [Pi](https://github.com/earendil-works/pi) que registra o provedor `github-copilot-compat`. Ele dá acesso aos modelos do GitHub Copilot por dois caminhos que o provedor nativo `github-copilot` não oferece:

- **Chat Completions**: cada modelo do catálogo do Copilot, chamado por `/chat/completions`.
- **Responses por WebSocket**: para cada modelo que fala a API Responses, um segundo modelo com o sufixo `-ws`, que usa só WebSocket e nunca cai para HTTP.

## Como funciona

- O login é o OAuth nativo do Copilot, incluindo a configuração de políticas de modelo. As credenciais ficam guardadas separadas das do provedor nativo.
- Depois de cada login e de cada renovação do token, a extensão consulta `/models` na API do Copilot e guarda quais modelos anunciam `/chat/completions` e `ws:/responses`.
- O seletor de modelos mostra só os modelos confirmados nessa consulta. Um modelo desativado por política ou sem suporte a ferramentas fica de fora.
- Se a consulta falhar, a lista anterior é descartada e nenhum modelo aparece até uma renovação ou um login que consiga consultar o catálogo.

Esse filtro vale para o seletor. Uma busca direta por modelo ou uma substituição local em `models.json` passa por fora dele, então ele não é uma barreira de segurança.

## Instalação

Como pacote do Pi (o repositório é privado, então o `git` precisa estar autenticado no GitHub):

```bash
pi install git:github.com/Electivus/pi-github-copilot-compat
```

Para testar sem instalar, a partir de um clone:

```bash
pi -e ./index.ts
```

Depois, dentro do Pi:

```
/login github-copilot-compat
```

Quem já tinha feito login numa versão anterior precisa fazer de novo para atualizar o catálogo.

## Testes

Requer Node 22.19 ou mais novo.

```bash
npm install --ignore-scripts
npm test
```

Os testes usam credenciais falsas e substituem `fetch` e `WebSocket`; uma requisição inesperada faz o teste falhar.

## Arquivos

- `index.ts`: o provedor, o login com descoberta do catálogo e o filtro de modelos.
- `websocket.ts`: um `fetch` que envia a requisição Responses por WebSocket e devolve os quadros como SSE.
- `test.ts`, `websocket.test.ts`: os testes de cada um.
