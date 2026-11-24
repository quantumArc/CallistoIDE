# Callisto harness evals

A small, repeatable set of coding tasks for the `@Callisto` agent, so that a harness change (a prompt, the loop
breaker, the tool loop, summaries) can be measured instead of judged from one manual run. Each task runs in its own
scratch project with its own config, against Callisto's **browser build** and the model loaded in LM Studio, and ends
with an automatic pass/fail check. Alongside the result the runner records what the task cost: time, model calls, tool
calls, and how many prompt tokens LM Studio had to read again instead of taking them from its cache.

## Running it

1. **LM Studio** serves on `localhost:1234` with the model loaded at the context length you normally use:

   ```bash
   ~/.cache/lm-studio/bin/lms load thinkingmachines/inkling-2-mini --context-length 99584 -y
   ```

2. **The browser build** is up to date with the harness code you want to measure (see [Rebuilding](#rebuilding)).
3. **Quit the Electron Callisto** while the evals run: it shares LM Studio, and its model calls would be counted against
   the tasks and slow them down. The runner warns if it is running.

```bash
node evals/run.mjs
```

| Option | Default | |
|---|---|---|
| `--tasks fix-bug,rename` | all | Run only these tasks (folder names under `tasks/`). |
| `--reasoning low` | `low` | Thinking level for `@Callisto`: `low`, `medium`, `high` (what you use in Callisto). |
| `--model lmstudio/<id>` | Callisto's default | Another model for `@Callisto`. Pair it with `--lmstudio-model <id>`, which the preflight checks is loaded. |
| `--label text` | | A note saved with the run, e.g. `before loop-breaker change`. |
| `--port 3100` | `3100` | Port for the browser build. |
| `--allow-unloaded` | off | Let LM Studio load the model on demand (with its default context length). |

Each run prints one line per task as it finishes, then a table, and saves `results/<run id>/` (not committed):
`results.md` (the table), `results.json` (everything, per turn), and per task the saved chat (`<task>.chat.json`), the
browser backend's log, and LM Studio's log for each message (`<task>.turnN.lmstudio.log`). The scratch projects stay in
`$TMPDIR/callisto-evals/<run id>/` for inspection.

`node evals/reanalyze.mjs evals/results/<run id>` recomputes a run's LM Studio numbers from those saved logs, for when
the log parser changes; pass/fail and times are kept.

A full run takes about 8 minutes at the `low` thinking level, mostly model time; expect much longer at `high`.

## Tasks

| Task | What it tests | Passes when |
|---|---|---|
| `parallel-reads` | Reading several files in one step and answering precisely (one name is a trap: a helper with the same name that is not exported). | The answer names exactly `format`, `render`, `validate`; no file changed. |
| `fix-bug` | Debugging from a failing test (`median` sorts numbers as strings). | Visible and hidden tests pass; the test file is untouched. |
| `add-feature` | Extending a module and its tests. | Hidden tests for `remove(id)` pass; the agent added its own tests; all tests pass. |
| `rename` | A change across several files. | No `areaOfCircle` left anywhere; visible and hidden tests pass. |
| `build-wordfreq` | Writing a module plus command-line tool from a spec. | Hidden tests of `topWords` and the CLI pass. |
| `long-chat-summary` | Chat summaries: a ~25k-token first turn, then a follow-up that needs its answer. Runs with `callisto.agent.summarizeAfterTokens` at 16,000. | A summary was written, and the follow-up names `js/ai.js` and 900; no file changed. |
| `web-lookup` | Web search: find SearXNG's API documentation and read it (see `docs/web-search.md`). Needs SearXNG running at `http://127.0.0.1:8888` (or `CALLISTO_EVAL_SEARXNG_URL`); skipped otherwise. | The agent called `webSearch` and `fetchWebPage`, and named the `format` parameter with json, csv and rss. |

The hidden tests live in each task's `hidden/` folder, outside the scratch project, so the model never sees them.

## What the numbers mean

- **Time**: from sending each message until its reply was complete, summed over the task's messages. Work the model
  server does afterwards (Callisto writing a summary in the background) is listed separately in the notes.
- **Model calls**: chat completions LM Studio ran for the task (one per step of the tool loop, plus resumes).
- **Tool calls**: tool calls in the saved chat.
- **Prompt tokens re-read**: prompt tokens LM Studio had to process rather than reuse from its cache, from the
  `prompt eval time = … / N tokens` line llama.cpp logs at the end of every call. This is what makes a local model slow
  on a long chat; a prompt that drifts from what was cached shows up here first. The first task of a run also pays for
  reading Callisto's ~8,500-token instructions and tools once; after that they stay cached.
- **Tokens written**: tokens the model generated, reasoning included (llama.cpp's `eval time` line).
- **Last prompt**: the size of the last model call's prompt, as LM Studio reported it.
- **Notes**: loop-breaker interruptions, a hand-back to the user, timeouts, errors, background work, and what the check
  found. Model calls are counted where they end, so a summary Callisto starts the moment a reply completes is listed as
  background work, not as part of the turn.

Inkling's runs vary a lot from one to the next (the same request has taken 12 seconds or several minutes of thinking).
Judge a change on two or three runs, by the pass count and the totals, not on one task's time.

## How it works

`run.mjs` copies each task's `fixture/` into a scratch workspace, writes a scratch `settings.json` and starts
`applications/browser` on it with `THEIA_CONFIG_DIR` pointing at the scratch config. A headless Chrome (Puppeteer, from
the repository's own dependencies) opens a new chat and types the task's messages. The runner follows the agent through
the chat Callisto saves to disk, and measures LM Studio through its server log
(`~/.cache/lm-studio/server-logs/`). After the last message it waits until LM Studio is idle, stops the server, and runs
the task's `check.mjs`.

The scratch settings auto-approve every tool, `shellExecute` included, so commands the model writes run on this machine
without asking, inside the scratch project. They also turn off chat titles, which would add a model call per task.

The Electron app is never started: it allows only one instance, so launching it would reach into your own window.

## Rebuilding

The browser build bundles the harness, so after changing `theia-extensions/product`:

```bash
yarn --cwd theia-extensions/product build
yarn --cwd applications/browser build
```

Building the browser app switches the native modules in `node_modules` to Node's ABI. Before you next build or run the
Electron app, build it again (`yarn --cwd applications/electron build`). If it then dies at startup, re-sign its native
modules: for each `.node` file in `applications/electron/lib/backend/native`, run
`cp -p f f.tmp && mv -f f.tmp f && codesign --force -s - f`.

## Adding a task

Create `tasks/<id>/` with:

- `task.json`: `title`, `turns` (each with a `message`, starting the first with `@Callisto`; optional `timeoutMinutes`,
  default 15; optional `waitForSummary`), and optional `settings` merged into the scratch `settings.json`;
- `fixture/`: the starting project (optional);
- `check.mjs`: `export default async function check({ workspace, fixtureDir, answers, turnResults, chat })` returning
  `{ pass, notes }`, where `chat` is the saved chat session (tool calls and their results included).
  `harness/check-utils.mjs` has helpers for running tests and comparing files.
- `requires` in `task.json` (optional): `["searxng"]` skips the task when SearXNG is not running.

Make the check pass a reference solution and fail the untouched fixture before relying on it.

## Limits

- **The tasks are small.** At the `low` thinking level Inkling passes all six, so today the suite guards against
  regressions and measures cost (time, calls, cache use) more than it tells good harnesses from great ones. Harder
  tasks belong here next: a multi-file app built from scratch (the chess app that once sent Inkling into a 16-minute
  loop), a bug that needs a debugger-style hunt, and runs at `--reasoning high`, where the loop breaker matters most.
- **It drives the UI.** The runner relies on the chat input's `.theia-ChatInput-Editor` class and the
  `Chat: New Chat` command; a Theia upgrade that renames them will show up as "The chat message was not sent".
- **LM Studio is shared.** Anything else using it during a run is counted against the tasks.

## Baseline

Two runs on 2026-11-24 (M4 Max, 128 GB): harness `c765865` (chat summaries and the parallel-tool-call cache fix
included), Inkling 2 Mini Q4_K_M at a 99,584-token context with 4 parallel slots, thinking level `low`. Values are
run 1 / run 2.

| Task | Result | Time | Model calls | Tool calls | Prompt tokens re-read | Tokens written |
|---|---|---|---|---|---|---|
| add-feature | pass / pass | 40s / 34s | 8 / 5 | 8 / 5 | 2,493 / 2,065 | 910 / 807 |
| build-wordfreq | pass / pass | 32s / 32s | 5 / 6 | 4 / 5 | 1,255 / 1,528 | 806 / 807 |
| fix-bug | pass / pass | 40s / 34s | 9 / 9 | 9 / 9 | 2,713 / 2,539 | 884 / 699 |
| long-chat-summary | pass / pass | 1m 50s / 1m 50s | 7 / 7 | 10 / 10 | 17,077 / 17,548 | 897 / 814 |
| parallel-reads | pass / pass | 10s / 10s | 2 / 2 | 3 / 3 | 701 / 701 | 191 / 194 |
| rename | pass / pass | 20s / 20s | 6 / 6 | 5 / 5 | 1,475 / 1,476 | 373 / 369 |
| **Total** | **6/6 / 6/6** | **4m 12s / 4m 00s** | | | | |

In `long-chat-summary`, the first message reads about 25,000 tokens of chess-app code, so most of its re-read tokens
are the files themselves. Callisto then wrote its summary in the background: one model call that re-read only about
650 tokens (the rest of the chat came from LM Studio's cache), producing a 377- and a 565-word summary. The follow-up was answered from the summary
alone, correctly and without tool calls, re-reading 871 and 1,342 tokens.

Everything else re-reads 700–2,700 tokens per task: the new message, tool results and the model's own replies, with
Callisto's instructions and tools served from the cache.
