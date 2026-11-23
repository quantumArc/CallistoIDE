/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** RPC path of the backend service that asks local model servers which models they have. */
export const LOCAL_MODEL_DISCOVERY_PATH = '/services/callisto/local-model-discovery';

export const LocalModelDiscoveryService = Symbol('LocalModelDiscoveryService');

export interface LocalModelInfo {
    /** Model id as the server names it. */
    id: string;
    /**
     * Graded thinking levels the server honours for this model (e.g. `low`, `medium`, `high`), in increasing
     * order, and the model's own default. Absent for models that can only turn thinking on or off, or none at all.
     */
    reasoning?: { levels: string[]; defaultLevel?: string };
}

export interface LocalModelListResult {
    /** Chat-capable models only: embedding and image-generation models are left out. */
    models: LocalModelInfo[];
    /** Set when the server could not be reached or answered with an error. */
    error?: string;
}

/**
 * Runs in the backend: LM Studio sends no CORS headers, so the browser window cannot query it directly.
 */
export interface LocalModelDiscoveryService {
    /** @param baseUrl the OpenAI-compatible base URL, e.g. `http://localhost:1234/v1` */
    listLmStudioModels(baseUrl: string): Promise<LocalModelListResult>;
    /** @param host the Ollama host, e.g. `http://localhost:11434` */
    listOllamaModels(host: string): Promise<LocalModelListResult>;
}
