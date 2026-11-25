# The Callisto agent's browser

`@Callisto` can check the web pages it builds: its `browser` tool opens a page in a headless Chrome, does what a user
would (click, type, press keys, pick from a list, drag, scroll), and reports what came of it:

- **console errors and warnings, uncaught exceptions, failed requests and HTTP errors**, with repeats counted
  (`×40`) and sources given as workspace paths (`js/app.js:12`);
- **the controls on screen**: buttons, links, inputs, selects and canvases, with their labels, a selector when they
  have an id, and their centre in pixels, so the model can click them by text, selector or position;
- **the visible text**, shortened;
- **a screenshot**, which a model that can see images looks at itself (Inkling 2 Mini can). The screenshot also shows
  in the chat, in the tool call.
- the value of a JavaScript expression evaluated in the page, when asked for (`window.game.turn`).

The page stays open between calls, so the model can open its app, play a move, and look again; after it edits a file it
opens the page again. Dialogs (`alert`, `confirm`) are answered OK and listed in the log.

## What it opens

- **An HTML file of the workspace** (`path`, e.g. `index.html` or `dist/index.html`). Callisto serves the file's
  workspace folder over HTTP on `127.0.0.1` (a random port, no caching), because ES modules, `fetch` and workers do
  not work from `file://`. A built page that asks for `/assets/…` from the site root (Vite's default) is served from
  its own folder.
- **A page of a server on this machine** (`url`, e.g. `http://localhost:5173/`), such as a dev server the model
  started with a launch configuration.

It never opens pages on the internet or the local network: it is for checking your own work, and reading the web is
`fetchWebPage`'s job, as text. Pages you open can still load scripts from the internet (a CDN copy of three.js, say).

A project with a bundler (Vite, webpack) cannot run from its source HTML: a bare import such as `import * as THREE from
'three'` fails in the browser. The tool says so, and the agent's instructions tell it to build the project and open the
built page, or open the dev server's URL.

## Screenshots and the model

Chat Completions has no images in tool results, and Theia turned an image a tool returns into ~100k characters of
base64 text. Callisto's tool loop sends the tool result's text as the tool message and the screenshot right after the
turn's tool messages, in a message of its own; later requests rebuild the chat the same way, so LM Studio's prompt cache
keeps matching.

The screenshot goes to LM Studio models that LM Studio reports as vision-capable (`capabilities.vision`), and to OpenAI
models. Other models (Ollama, LM Studio models without a vision projector) get the text report and a line saying the
screenshot was left out; so do screenshots already in the chat when you switch to such a model.

Screenshots are JPEGs of the viewport (1280×800 unless the model asks for another size; a pixel of the screenshot is a
CSS pixel, so the model can click where it sees something).

## The browser itself

Callisto uses the newest Chrome that Puppeteer downloaded to `~/.cache/puppeteer` (the headless shell first: it starts
fastest), else an installed Chrome, Edge, Brave or Chromium. To install the headless shell:

```bash
npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer
```

or set `callisto.browser.executablePath` to the browser you want. WebGL works without a GPU (SwiftShader), so 3D pages
render, more slowly than on screen. The browser starts on the first call (about a second) and is shut down after 10
idle minutes and when Callisto exits.

## Settings

| Setting | Default | |
|---|---|---|
| `callisto.browser.enabled` | `true` | Turns the tool off; the agent is then told to check its work another way. |
| `callisto.browser.executablePath` | empty | The browser to use; empty to look for one as above. |

Like other tools, `browser` asks for confirmation until you set it to "Always allow" (AI Configuration → Tools).
