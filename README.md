# Callisto

An AI code editor that runs your own models locally. Callisto is built on the open-source
[Eclipse Theia](https://theia-ide.org) platform and is tuned for capable local models such as
**Inkling 2 Mini**, served by [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com).

## Features

- **Every local model, automatically.** Callisto lists every chat model from your LM Studio and Ollama
  servers in its model pickers (`lmstudio/<model>`, `ollama/<model>`) and checks for new or removed models
  every 30 seconds. Run **Callisto: Refresh Local Models** to check right away.
- **Thinking levels.** Models that support graded thinking in LM Studio (Inkling 2 Mini, Qwen3.8, GPT-OSS)
  get a thinking-level picker in the chat input. Inkling defaults to **medium**.
- **Live run stats.** Elapsed time, output tokens and tokens per second appear next to *Thinking* and, for the
  whole run, in the status bar. Token counts are exact for finished model calls and estimated for the one still
  streaming.
- **The Callisto agent** (`@Callisto`, the default), a coding agent built for local models:
  - a short system prompt with an understand → plan → act → verify → report loop;
  - **Agent** mode (edits files, runs tests and commands, every action needs your approval by default) and
    **Review** mode (proposes changes for you to apply);
  - a **loop breaker**: the model's reasoning is watched while it streams; when it goes in circles or runs very
    long without acting, the model call is interrupted and resumed with a nudge to take the next step;
  - a **loop guard** on tool calls: repeated identical calls, repeated full rewrites of one file and runaway tool
    use are refused with an instruction to change course.
- **Everything else from Theia**: a VS Code–compatible editor, extensions from [Open VSX](https://open-vsx.org),
  terminal, debugger, Git, and Theia's other AI agents.

## Requirements

- macOS (the desktop app is currently built and tested on macOS with Apple Silicon)
- [Node.js](https://nodejs.org) 24 or later
- [Yarn](https://classic.yarnpkg.com) 1.x: `npm install -g yarn`
- A local model server:
  - **LM Studio** with its server running (default `http://localhost:1234`), or
  - **Ollama** (default `http://localhost:11434`)

### Model server settings that matter

Raise the **default context length** in LM Studio's settings (for example to 131072). With its usual default of
8192 tokens, a coding agent's instructions and tools leave too little room, and the model stops mid-thought.

## Getting started

```bash
yarn install
yarn download:plugins   # the built-in VS Code extensions (syntax highlighting, Git, …)
yarn build:dev          # build the extensions and both applications in development mode
yarn electron start     # start the desktop app
```

To run the browser version instead (served on http://localhost:3000):

```bash
yarn browser start
```

## Configuration

Callisto keeps its settings in `~/.callisto`. The relevant settings are under **Settings › AI Features**:

| Setting | Default | What it does |
|---|---|---|
| `callisto.localModels.autoDiscover` | `true` | List LM Studio and Ollama models automatically |
| `callisto.localModels.lmStudioUrl` | `http://localhost:1234/v1` | LM Studio's OpenAI-compatible endpoint |
| `callisto.localModels.refreshIntervalSeconds` | `30` | How often to check for added or removed models |
| `callisto.agent.loopBreaker` | `true` | Interrupt reasoning that goes in circles or runs very long |
| `callisto.agent.maxThinkingTokens` | `16000` | Longest stretch of reasoning before the agent is asked to act |
| `ai-features.ollama.ollamaHost` | `http://localhost:11434` | Ollama server (Theia setting) |

The default model for each agent is set in **AI Configuration › Model Aliases**, and the thinking level per model
under `ai-features.reasoning.defaults`. Out of the box everything uses `lmstudio/thinkingmachines/inkling-2-mini`.

## Project layout

| Path | Contents |
|---|---|
| `applications/electron` | The desktop app: name, icons, default settings, packaging (`electron-builder.yml`) |
| `applications/browser` | The browser version of the same app |
| `theia-extensions/product` | Callisto's own code: branding, local model discovery, run stats, the Callisto agent |
| `theia-extensions/launcher` | Command-line launcher support (from Theia IDE) |
| `plugins` | Downloaded built-in VS Code extensions (not committed) |

Inside `theia-extensions/product/src`:

| File | What it does |
|---|---|
| `browser/callisto-agent.ts` | The Callisto agent, loop breaker, loop guard |
| `common/callisto-agent-prompts.ts` | The agent's Agent and Review mode prompts |
| `common/thinking-loop-detector.ts` | Detects repeating or overlong reasoning |
| `browser/local-models-contribution.ts`, `node/local-model-discovery-service.ts` | LM Studio and Ollama model discovery |
| `browser/ai-run-stats.ts` | Elapsed time, tokens and tokens per second |

## Packaging a Mac app

```bash
yarn build                 # production build
yarn package:applications  # writes the .dmg and .zip to applications/electron/dist
```

The app is unsigned unless you configure an Apple Developer certificate in `electron-builder.yml`.

## Updating Theia

The Theia platform comes in as npm packages. To move to a newer release:

```bash
yarn update:theia 1.78.0
yarn install
yarn build:dev
```

## License and attribution

Callisto started from the [Eclipse Theia IDE](https://github.com/eclipse-theia/theia-ide) project, which is
available under the MIT License; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). The Eclipse Theia platform
packages it depends on are available under the Eclipse Public License 2.0. Eclipse Theia is a trademark of the
Eclipse Foundation; Callisto is not affiliated with or endorsed by the Eclipse Foundation.
