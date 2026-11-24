# Web search for the Callisto agent

`@Callisto` can search the web and read web pages through your own [SearXNG](https://docs.searxng.org/): an
open-source metasearch engine that sends each query to several search engines (DuckDuckGo, Brave, Bing, Stack Overflow,
GitHub …) and merges the results. It runs on your Mac and only listens on `127.0.0.1`: no account, no API key, and your
searches are not tied to you.

The agent gets two tools:

- **`webSearch`**: titles, links and snippets for a query. `category: "code"` adds Stack Overflow, GitHub, MDN and
  package registries after the web results; `"news"` searches news.
- **`fetchWebPage`**: a page's main content as text (headings, lists, links and code kept; navigation, menus and
  scripts dropped), in parts for long pages. Only pages on the public internet: addresses on this Mac or the local
  network (LM Studio's API, a router) are refused, so a page the model read cannot steer it into probing them.

Each search and page read asks for your confirmation, like other tools, until you set it to "Always allow".

## Setting up SearXNG on macOS

SearXNG's own installer (`utils/searxng.sh install all`) is for Linux servers (systemd, nginx, uWSGI) and stops on macOS
with `/etc/os-release: No such file or directory`. On a Mac, run SearXNG the way its developers do: a Python environment
and one command. These steps keep everything in your clone's `local/` folder, which git ignores.

1. Get SearXNG and its Python packages ([uv](https://docs.astral.sh/uv/) brings its own Python, so conda or Homebrew
   Python versions do not matter):

   ```bash
   git clone https://github.com/searxng/searxng.git ~/Documents/searxng
   cd ~/Documents/searxng
   uv venv --python 3.13 --python-preference only-managed local/venv
   uv pip install --python local/venv/bin/python -r requirements.txt
   ```

2. Write `local/settings.yml` (put the output of `openssl rand -hex 32` in `secret_key`):

   ```yaml
   use_default_settings: true

   general:
     instance_name: "Callisto search"
     enable_metrics: false
     # Wikipedia, Wikidata and OpenStreetMap stay off without a contact address, which is sent to them with each query.
     # contact_url: "mailto:you@example.com"

   search:
     safe_search: 0
     autocomplete: ""
     formats:
       - html
       - json          # Callisto uses the JSON API

   server:
     bind_address: "127.0.0.1"   # only this Mac can connect; never 0.0.0.0
     port: 8888
     secret_key: "<openssl rand -hex 32>"
     limiter: false              # the rate limiter is for public instances
     public_instance: false
     image_proxy: false
     method: "GET"

   outgoing:
     request_timeout: 5.0
     max_request_timeout: 10.0

   engines:
     - name: brave
       disabled: false
     - name: bing
       disabled: false
     - name: google cse          # timed out on every query
       disabled: true
   ```

3. Write `local/launch.py`, which starts SearXNG with one network fix (see [Troubleshooting](#troubleshooting)):

   ```python
   """Starts SearXNG with Encrypted ClientHello (ECH) switched off for its outgoing requests."""
   import os
   import runpy
   import sys

   from curl_cffi import CurlOpt
   from curl_cffi.requests import session as _session

   _original_init = _session.BaseSession.__init__


   def _init_without_ech(self, *args, **kwargs):
       _original_init(self, *args, **kwargs)
       self.curl_options.setdefault(CurlOpt.ECH, "false")


   _session.BaseSession.__init__ = _init_without_ech

   sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
   runpy.run_module("searx.webapp", run_name="__main__", alter_sys=True)
   ```

4. Write `local/searxng.sh`, to turn SearXNG on and off, and make it executable (`chmod +x local/searxng.sh`):

   ```bash
   #!/usr/bin/env bash
   # searxng start | stop | status: runs SearXNG in the background on http://127.0.0.1:8888 until stopped.
   set -euo pipefail
   DIR="$HOME/Documents/searxng"
   LOG="$HOME/Library/Logs/searxng.log"
   PIDFILE="$DIR/local/searxng.pid"
   PORT=8888
   running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
   case "${1:-status}" in
     start)
       if running; then echo "SearXNG is already running."; exit 0; fi
       other="$(lsof -nP -t -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -1 || true)"
       if [ -n "$other" ]; then
         echo "Port $PORT is already used by process $other ($(ps -o command= -p "$other" | cut -c1-60)). Stop it first."; exit 1
       fi
       cd "$DIR"
       SEARXNG_SETTINGS_PATH=local/settings.yml nohup local/venv/bin/python local/launch.py >> "$LOG" 2>&1 &
       echo $! > "$PIDFILE"
       for _ in $(seq 1 30); do
         if ! running; then rm -f "$PIDFILE"; echo "SearXNG exited during startup; see $LOG"; exit 1; fi
         curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && { echo "SearXNG is running: http://127.0.0.1:$PORT"; exit 0; }
         sleep 1
       done
       echo "SearXNG did not answer within 30 s; see $LOG"; exit 1 ;;
     stop)
       if running; then kill "$(cat "$PIDFILE")"; echo "SearXNG stopped."; else echo "SearXNG is not running."; fi
       rm -f "$PIDFILE" ;;
     status)
       if running; then echo "SearXNG is running: http://127.0.0.1:$PORT"; else echo "SearXNG is not running."; fi ;;
     *) echo "Usage: searxng start|stop|status"; exit 2 ;;
   esac
   ```

   A short command for it: `echo 'alias searxng="$HOME/Documents/searxng/local/searxng.sh"' >> ~/.zshrc`.

5. Try it: `searxng start`, then open <http://127.0.0.1:8888> or
   `curl -s "http://127.0.0.1:8888/search?q=hello&format=json" | head -c 300`.

To update SearXNG later: `cd ~/Documents/searxng && git pull`, run the `uv pip install` line again, and restart it.

SearXNG only runs while you have it on. If you would rather have it always on, a launchd agent can start it at login,
but not from `~/Documents`: macOS does not let background services read Documents, Desktop or Downloads.

## Callisto settings

| Setting | Default | |
|---|---|---|
| `callisto.webSearch.enabled` | `true` | Turns the two tools off when `false`. |
| `callisto.webSearch.searxngUrl` | `http://127.0.0.1:8888` | Where SearXNG answers. |
| `callisto.webSearch.controlScript` | empty | A script that takes `start` and `stop`, e.g. `~/Documents/searxng/local/searxng.sh`. When the agent searches and SearXNG is off, Callisto runs `<script> start`, and `<script> stop` when Callisto exits. A SearXNG you started yourself is left running. Empty: Callisto never starts it; the agent tells you it is off. |

## Troubleshooting

- **Every engine times out** (`unresponsive_engines` lists them all, while `curl` reaches the same sites in a moment).
  SearXNG makes its requests look like Chrome or Firefox, including the TLS extension *ECH GREASE*. Some networks drop
  handshakes that carry it; on the network this was set up on, every engine timed out until ECH was switched off, after
  which they answered in 0.1–2 s. That is what `launch.py` does. Run SearXNG through it, not `python -m searx.webapp`.
- **`wikipedia engine requires general.contact_url`** at startup: set `contact_url` (step 2) to turn Wikipedia,
  Wikidata and OpenStreetMap on. The `ahmia` and `torch` errors are Tor search engines and can be ignored, as can
  `missing config file: local/limiter.toml` and `X-Forwarded-For nor X-Real-IP header is set!`.
- **`Address already in use`**: another SearXNG (or another program) has port 8888. `lsof -nP -iTCP:8888 -sTCP:LISTEN`
  shows which.
- **The agent says SearXNG is not running**: start it (`searxng start`) or set `callisto.webSearch.controlScript`.
