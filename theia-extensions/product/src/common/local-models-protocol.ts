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
    /** LM Studio only: context length the model is loaded with, the most it supports, and its parallel request slots. */
    context?: { loaded?: number; max?: number; parallel?: number };
    /** LM Studio only: whether the model takes images (it has a vision projector), so it can be shown screenshots. */
    vision?: boolean;
}

export interface LocalModelListResult {
    /** Chat-capable models only: embedding and image-generation models are left out. */
    models: LocalModelInfo[];
    /** Set when the server could not be reached or answered with an error. */
    error?: string;
}

/** LM Studio's estimate of what loading a model with a given context length would take. */
export interface LmStudioLoadEstimate {
    /** Estimated memory in GiB (weights plus the context's cache). */
    gib?: number;
    /** False when LM Studio says its resource guardrails would refuse the load. */
    fits?: boolean;
    error?: string;
}

export interface LmStudioReloadResult {
    ok: boolean;
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
    /** Memory LM Studio estimates for loading the model with this context length; loads nothing. Uses the `lms` CLI. */
    estimateLmStudioLoad(modelKey: string, contextLength: number, parallel: number): Promise<LmStudioLoadEstimate>;
    /**
     * Unloads the model and loads it again with this context length and number of parallel predictions. Whatever the
     * model is generating stops, and its prompt cache is lost. Uses the `lms` CLI.
     */
    reloadLmStudioModel(modelKey: string, contextLength: number, parallel: number): Promise<LmStudioReloadResult>;
}
