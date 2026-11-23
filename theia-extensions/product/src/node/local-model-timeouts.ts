/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as undici from 'undici';
import { isLocalEndpoint } from './callisto-chat-completion-stream.js';

/**
 * How long to wait for a local model server to start answering. LM Studio sends no response headers until it has read
 * the whole prompt, and on a long conversation that takes minutes (a 68k-token chess-app chat took ~6 minutes at
 * 200–450 tokens/s). Node's `fetch` gives up after 5 minutes without headers, which cut that request off at 79%.
 */
export const LOCAL_MODEL_HEADERS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Routes requests to servers on this machine or the local network through an agent that waits
 * {@link LOCAL_MODEL_HEADERS_TIMEOUT_MS} for response headers; everything else goes through the dispatcher that was
 * there before, unchanged.
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
export function installLocalModelTimeouts(headersTimeout = LOCAL_MODEL_HEADERS_TIMEOUT_MS): void {
    if (installed) {
        return;
    }
    installed = true;
    const local = new undici.Agent({ headersTimeout });
    undici.setGlobalDispatcher(new LocalModelDispatcher(local, undici.getGlobalDispatcher()));
}
