/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
    LmStudioLoadEstimate, LmStudioReloadResult, LocalModelDiscoveryService, LocalModelInfo, LocalModelListResult
} from '../common/local-models-protocol.js';

const REQUEST_TIMEOUT_MS = 3000;
const ESTIMATE_TIMEOUT_MS = 60_000;
/** Loading reads the whole model from disk again; 17 GB took ~4 s from LM Studio's cache, far longer cold. */
const LOAD_TIMEOUT_MS = 5 * 60_000;
const LMS_MISSING = 'LM Studio\'s command-line tool `lms` was not found (looked in ~/.lmstudio/bin, ~/.cache/lm-studio/bin and the PATH). '
    + 'Run it once from LM Studio (Developer → "Install lms"), or change the context length in LM Studio itself.';

function runLms(lms: string, args: string[], timeout: number): Promise<{ code: number; output: string }> {
    return new Promise(resolve => {
        execFile(lms, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
            // `lms` draws progress bars with carriage returns and terminal escapes.
            resolve({ code, output: `${stdout}\n${stderr}`.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n') });
        });
    });
}

/** The line of `lms` output that says what went wrong: one naming an error, else the first one. */
function lastLine(output: string): string {
    const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.find(line => /error|not found|no model|fail|insufficient|exceed/i.test(line) && line.length > 15) ?? lines[0] ?? '';
}

/**
 * The thinking levels LM Studio's `reasoning_effort` actually grades, in increasing order. Models that only
 * offer `off`/`on` (Gemma 4, for example) ignore `reasoning_effort`, so they get no level picker.
 */
const GRADED_LEVELS = ['low', 'medium', 'high', 'xhigh'];

/** An entry of LM Studio's `GET /api/v1/models`. */
interface LmStudioV1Model {
    key: string;
    /** 'llm' | 'vlm' | 'embedding' */
    type?: string;
    architecture?: string;
    capabilities?: { vision?: boolean; reasoning?: { allowed_options?: string[]; default?: string } };
    max_context_length?: number;
    loaded_instances?: { config?: { context_length?: number; parallel?: number } }[];
}

/** An entry of LM Studio's older `GET /api/v0/models`. */
interface LmStudioV0Model {
    id: string;
    type?: string;
}

interface OllamaTag {
    name: string;
    details?: { family?: string; families?: string[] };
}

@injectable()
export class LocalModelDiscoveryServiceImpl implements LocalModelDiscoveryService {

    async listLmStudioModels(baseUrl: string): Promise<LocalModelListResult> {
        const base = baseUrl.replace(/\/+$/, '');
        const root = base.replace(/\/v1$/, '');
        // Newest API first: only it reports thinking levels and tells image generators apart.
        try {
            const v1 = await this.getJson<{ models: LmStudioV1Model[] }>(`${root}/api/v1/models`);
            return { models: v1.models.filter(m => this.isLmStudioChatModel(m)).map(m => this.toLmStudioInfo(m)) };
        } catch {
            // An older LM Studio: try the previous native API.
        }
        try {
            const v0 = await this.getJson<{ data: LmStudioV0Model[] }>(`${root}/api/v0/models`);
            return { models: v0.data.filter(m => m.type !== 'embeddings').map(m => ({ id: m.id })) };
        } catch {
            // Not LM Studio's native API: fall back to the OpenAI-compatible list.
        }
        try {
            const openAi = await this.getJson<{ data: { id: string }[] }>(`${base}/models`);
            return { models: openAi.data.map(m => m.id).filter(id => !/embed/i.test(id)).map(id => ({ id })) };
        } catch (error) {
            return { models: [], error: this.describe(error) };
        }
    }

    async listOllamaModels(host: string): Promise<LocalModelListResult> {
        try {
            const tags = await this.getJson<{ models: OllamaTag[] }>(`${host.replace(/\/+$/, '')}/api/tags`);
            const isEmbedding = (tag: OllamaTag) =>
                [tag.details?.family, ...(tag.details?.families ?? [])].some(f => !!f && /bert|embed/i.test(f)) || /embed/i.test(tag.name);
            return { models: tags.models.filter(tag => !isEmbedding(tag)).map(tag => ({ id: tag.name })) };
        } catch (error) {
            return { models: [], error: this.describe(error) };
        }
    }

    protected isLmStudioChatModel(model: LmStudioV1Model): boolean {
        if (model.type !== 'llm' && model.type !== 'vlm') {
            return false;
        }
        // Image generators are listed as 'llm' but cannot write text.
        return !/image/i.test(model.architecture ?? '') && !/image/i.test(model.key);
    }

    protected toLmStudioInfo(model: LmStudioV1Model): LocalModelInfo {
        const info: LocalModelInfo = { id: model.key };
        const loaded = model.loaded_instances?.[0]?.config;
        if (loaded?.context_length || model.max_context_length) {
            info.context = { loaded: loaded?.context_length, max: model.max_context_length, parallel: loaded?.parallel };
        }
        if (typeof model.capabilities?.vision === 'boolean') {
            info.vision = model.capabilities.vision;
        }
        const reasoning = model.capabilities?.reasoning;
        const levels = GRADED_LEVELS.filter(level => reasoning?.allowed_options?.includes(level));
        if (levels.length) {
            const defaultLevel = reasoning?.default && levels.includes(reasoning.default) ? reasoning.default : undefined;
            info.reasoning = { levels, defaultLevel };
        }
        return info;
    }

    async estimateLmStudioLoad(modelKey: string, contextLength: number, parallel: number): Promise<LmStudioLoadEstimate> {
        const lms = this.findLms();
        if (!lms) {
            return { error: LMS_MISSING };
        }
        const { code, output } = await runLms(lms, ['load', modelKey, '--context-length', String(contextLength),
            '--parallel', String(parallel), '--estimate-only', '-y'], ESTIMATE_TIMEOUT_MS);
        const gib = output.match(/Estimated Total Memory:\s*([\d.]+)\s*GiB/i)?.[1];
        if (code !== 0 && !gib) {
            return { error: lastLine(output) || `lms exited with code ${code}` };
        }
        return { gib: gib ? Number(gib) : undefined, fits: !/will (fail|not)|exceed|insufficient|cannot be loaded/i.test(output) };
    }

    async reloadLmStudioModel(modelKey: string, contextLength: number, parallel: number): Promise<LmStudioReloadResult> {
        const lms = this.findLms();
        if (!lms) {
            return { ok: false, error: LMS_MISSING };
        }
        // Unloading first: loading a model that is already loaded would add a second copy instead of replacing it.
        await runLms(lms, ['unload', modelKey], ESTIMATE_TIMEOUT_MS);
        const { code, output } = await runLms(lms, ['load', modelKey, '--context-length', String(contextLength),
            '--parallel', String(parallel), '-y'], LOAD_TIMEOUT_MS);
        return code === 0 ? { ok: true } : { ok: false, error: lastLine(output) || `lms exited with code ${code}` };
    }

    /** LM Studio's CLI: where LM Studio installs it, or on the PATH. */
    protected findLms(): string | undefined {
        const candidates = [join(homedir(), '.lmstudio', 'bin', 'lms'), join(homedir(), '.cache', 'lm-studio', 'bin', 'lms'),
            ...(process.env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'lms'))];
        return candidates.find(path => existsSync(path));
    }

    protected async getJson<T>(url: string): Promise<T> {
        const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${url}`);
        }
        return await response.json() as T;
    }

    protected describe(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
