/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as undici from 'undici';
import { isLocalEndpoint } from './callisto-chat-completion-stream.js';

/**
 * How long a local model server may stay silent while it reads the prompt. On a long conversation that takes minutes,
 * and it slows down as the context fills: Inkling 2 Mini read a 65k-token chat at 650 tokens/s at first and under
 * 130 tokens/s past 50k, about 6½ minutes in all; a full 99k-token context would take about 12. Resuming a chat after
 * LM Studio restarted, or after it unloaded the model, re-reads all of it, because the prompt cache is gone.
 *
 * Node's `fetch` gives up after 5 minutes of silence, and the silence can fall in either phase of the response:
 * - before the response headers (`UND_ERR_HEADERS_TIMEOUT`): a 68k-token chess-app chat was cut off at 79%;
 * - after them, before the first byte of the body (`UND_ERR_BODY_TIMEOUT`): the current LM Studio sends the headers of
 *   a streamed response as soon as the model is loaded and then nothing until the first token, which cut off a resume
 *   of a 65k-token chat at 83% (2026-11-24).
 * Once the model is answering, it sends a chunk per token, so this limit only matters while the prompt is read.
 */
export const LOCAL_MODEL_SILENCE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Routes requests to servers on this machine or the local network through an agent that waits
 * {@link LOCAL_MODEL_SILENCE_TIMEOUT_MS} for the response headers and for each piece of the body; everything else goes
 * through the dispatcher that was there before, unchanged.
 */
export class LocalModelDispatcher extends undici.Dispatcher {

    constructor(protected readonly local: undici.Dispatcher, protected readonly other: undici.Dispatcher) {
        super();
    }

    override dispatch(options: undici.Dispatcher.DispatchOptions, handler: undici.Dispatcher.DispatchHandler): boolean {
        const origin = options.origin === undefined ? undefined : String(options.origin);
        return (isLocalEndpoint(origin) ? this.local : this.other).dispatch(options, handler);
    }

    override async close(): Promise<void> {
        await Promise.all([this.local.close(), this.other.close()]);
    }

    override async destroy(): Promise<void> {
        await Promise.all([this.local.destroy(), this.other.destroy()]);
    }
}

let installed = false;

/**
 * Installs {@link LocalModelDispatcher} as the global dispatcher, which Node's built-in `fetch` (and so the OpenAI SDK,
 * when no proxy is configured) uses. Idempotent.
 */
export function installLocalModelTimeouts(silenceTimeout = LOCAL_MODEL_SILENCE_TIMEOUT_MS): void {
    if (installed) {
        return;
    }
    installed = true;
    const local = new undici.Agent({ headersTimeout: silenceTimeout, bodyTimeout: silenceTimeout });
    undici.setGlobalDispatcher(new LocalModelDispatcher(local, undici.getGlobalDispatcher()));
}
