# Changelog

## [0.2.0]

### Added

- Reasoning effort on Chat Completions: a model whose Copilot catalog entry declares `reasoning_effort` levels offers those thinking levels, and the picked level is sent as `reasoning_effort`. A level the model does not declare is not sent.

## [0.1.0]

- First version: Chat Completions for every Copilot catalog model and Responses over WebSocket through `-ws` models, limited to the endpoints the Copilot catalog advertises.
