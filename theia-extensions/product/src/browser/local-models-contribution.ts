/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command, CommandContribution, CommandRegistry, Emitter, Event, MessageService, PreferenceService } from '@theia/core';
import { ReasoningLevel, ReasoningSupport } from '@theia/ai-core';
import { OpenAiLanguageModelsManager, OpenAiModelDescription } from '@theia/ai-openai/lib/common';
import { OLLAMA_REASONING_SUPPORT, OllamaLanguageModelsManager } from '@theia/ai-ollama/lib/common';
import { HOST_PREF as OLLAMA_HOST_PREF } from '@theia/ai-ollama/lib/common/ollama-preferences';
import { LocalModelDiscoveryService, LocalModelInfo } from '../common/local-models-protocol.js';
import {
    LOCAL_MODELS_AUTO_DISCOVER_PREF, LOCAL_MODELS_LM_STUDIO_URL_PREF, LOCAL_MODELS_REFRESH_INTERVAL_PREF
} from './local-models-preferences.js';

export const REFRESH_LOCAL_MODELS: Command = {
    id: 'callisto.refreshLocalModels',
    category: 'Callisto',
    label: 'Refresh Local Models'
};

export const LM_STUDIO_PREFIX = 'lmstudio/';
const OLLAMA_PREFIX = 'ollama/';
const MAX_RETRIES_PREF = 'ai-features.modelSettings.maxRetries';

interface RefreshSummary {
    lmStudio: number;
    ollama: number;
    errors: string[];
}

/**
 * Registers every chat model served by the local LM Studio and Ollama servers, so they all show up in the
 * model pickers without listing them in the settings. Models stay registered while a server is unreachable,
 * and are removed only when the server answers without them.
 */
@injectable()
export class LocalModelsContribution implements FrontendApplicationContribution, CommandContribution {

    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    @inject(OpenAiLanguageModelsManager)
    protected readonly openAiManager: OpenAiLanguageModelsManager;

    @inject(OllamaLanguageModelsManager)
    protected readonly ollamaManager: OllamaLanguageModelsManager;

    @inject(LocalModelDiscoveryService)
    protected readonly discovery: LocalModelDiscoveryService;

    @inject(MessageService)
    protected readonly messages: MessageService;

    /** Registered LM Studio models, by id, with a fingerprint of their settings to notice changes. */
    protected lmStudioModels = new Map<string, string>();
    protected lmStudioUrl: string | undefined;
    protected ollamaModels = new Set<string>();
    protected timer: ReturnType<typeof setInterval> | undefined;
    protected pending: Promise<RefreshSummary> | undefined;
    /** What LM Studio last reported about each model, by id (without the `lmstudio/` prefix). */
    protected lmStudioInfo = new Map<string, LocalModelInfo>();
    protected readonly onDidChangeLmStudioInfoEmitter = new Emitter<void>();
    /** Fires after each refresh that reached LM Studio, e.g. when a model was reloaded with another context length. */
    readonly onDidChangeLmStudioInfo: Event<void> = this.onDidChangeLmStudioInfoEmitter.event;

    /** LM Studio's info for a Callisto model id such as `lmstudio/thinkingmachines/inkling-2-mini`. */
    getLmStudioInfo(languageModelId: string | undefined): LocalModelInfo | undefined {
        return languageModelId?.startsWith(LM_STUDIO_PREFIX) ? this.lmStudioInfo.get(languageModelId.slice(LM_STUDIO_PREFIX.length)) : undefined;
    }

    onStart(): void {
        this.preferences.ready.then(() => {
            this.refresh();
            this.schedule();
            this.preferences.onPreferenceChanged(event => {
                if (event.preferenceName.startsWith('callisto.localModels.') || event.preferenceName === OLLAMA_HOST_PREF) {
                    this.refresh();
                    this.schedule();
                }
            });
        });
    }

    onStop(): void {
        this.clearTimer();
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(REFRESH_LOCAL_MODELS, {
            execute: async () => {
                const summary = await this.refresh();
                const found = `Found ${summary.lmStudio} LM Studio and ${summary.ollama} Ollama models.`;
                if (summary.errors.length) {
                    this.messages.warn(`${found} ${summary.errors.join(' ')}`);
                } else {
                    this.messages.info(found);
                }
            }
        });
    }

    refresh(): Promise<RefreshSummary> {
        // One refresh at a time: the interval and a preference change can fire together.
        this.pending ??= this.doRefresh().finally(() => this.pending = undefined);
        return this.pending;
    }

    protected async doRefresh(): Promise<RefreshSummary> {
        const errors: string[] = [];
        if (!this.preferences.get<boolean>(LOCAL_MODELS_AUTO_DISCOVER_PREF, true)) {
            this.unregisterAll();
            return { lmStudio: 0, ollama: 0, errors };
        }

        const lmStudioUrl = this.preferences.get<string>(LOCAL_MODELS_LM_STUDIO_URL_PREF, 'http://localhost:1234/v1');
        const ollamaHost = this.preferences.get<string>(OLLAMA_HOST_PREF, 'http://localhost:11434');
        const [lmStudio, ollama] = await Promise.all([
            this.discovery.listLmStudioModels(lmStudioUrl),
            this.discovery.listOllamaModels(ollamaHost)
        ]);

        if (lmStudio.error) {
            errors.push(`LM Studio (${lmStudioUrl}) is not reachable: ${lmStudio.error}.`);
        } else {
            this.syncLmStudio(lmStudio.models, lmStudioUrl);
        }
        if (ollama.error) {
            errors.push(`Ollama (${ollamaHost}) is not reachable: ${ollama.error}.`);
        } else {
            this.syncOllama(ollama.models.map(model => model.id));
        }
        return { lmStudio: this.lmStudioModels.size, ollama: this.ollamaModels.size, errors };
    }

    protected syncLmStudio(models: LocalModelInfo[], url: string): void {
        const urlChanged = url !== this.lmStudioUrl;
        const current = new Map(models.map(model => [model.id, JSON.stringify(model.reasoning ?? null)]));
        const removed = [...this.lmStudioModels.keys()].filter(id => !current.has(id));
        // A changed URL has to be applied to every model; otherwise only to new models and changed thinking levels.
        const added = models.filter(model => urlChanged || this.lmStudioModels.get(model.id) !== current.get(model.id));
        if (removed.length) {
            this.openAiManager.removeLanguageModels(...removed.map(id => LM_STUDIO_PREFIX + id));
        }
        if (added.length) {
            const maxRetries = this.preferences.get<number>(MAX_RETRIES_PREF, 3);
            this.openAiManager.createOrUpdateLanguageModels(...added.map((model): OpenAiModelDescription => ({
                id: LM_STUDIO_PREFIX + model.id,
                model: model.id,
                url,
                // LM Studio ignores the key, but the OpenAI client refuses to send a request without one.
                apiKey: 'lm-studio',
                apiVersion: undefined,
                maxRetries,
                useResponseApi: false,
                // Shows the thinking-level picker in the chat input; the level is sent as `reasoning_effort`.
                reasoningSupport: this.toReasoningSupport(model)
            })));
        }
        this.lmStudioModels = current;
        this.lmStudioUrl = url;
        this.lmStudioInfo = new Map(models.map(model => [model.id, model]));
        this.onDidChangeLmStudioInfoEmitter.fire();
    }

    protected toReasoningSupport(model: LocalModelInfo): ReasoningSupport | undefined {
        if (!model.reasoning) {
            return undefined;
        }
        return {
            supportedLevels: model.reasoning.levels as ReasoningLevel[],
            defaultLevel: model.reasoning.defaultLevel as ReasoningLevel | undefined
        };
    }

    protected syncOllama(models: string[]): void {
        const removed = [...this.ollamaModels].filter(model => !models.includes(model));
        const added = models.filter(model => !this.ollamaModels.has(model));
        if (removed.length) {
            this.ollamaManager.removeLanguageModels(...removed.map(model => OLLAMA_PREFIX + model));
        }
        if (added.length) {
            this.ollamaManager.createOrUpdateLanguageModels(...added.map(model => ({
                id: OLLAMA_PREFIX + model,
                model,
                reasoningSupport: OLLAMA_REASONING_SUPPORT
            })));
        }
        this.ollamaModels = new Set(models);
    }

    protected unregisterAll(): void {
        if (this.lmStudioModels.size) {
            this.openAiManager.removeLanguageModels(...[...this.lmStudioModels.keys()].map(id => LM_STUDIO_PREFIX + id));
        }
        if (this.ollamaModels.size) {
            this.ollamaManager.removeLanguageModels(...[...this.ollamaModels].map(model => OLLAMA_PREFIX + model));
        }
        this.lmStudioModels.clear();
        this.ollamaModels.clear();
        this.lmStudioUrl = undefined;
    }

    protected schedule(): void {
        this.clearTimer();
        const seconds = this.preferences.get<number>(LOCAL_MODELS_REFRESH_INTERVAL_PREF, 30);
        if (this.preferences.get<boolean>(LOCAL_MODELS_AUTO_DISCOVER_PREF, true) && seconds > 0) {
            this.timer = setInterval(() => this.refresh(), seconds * 1000);
        }
    }

    protected clearTimer(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
}
