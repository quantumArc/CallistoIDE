/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { Command, CommandContribution, CommandRegistry, Emitter, Event, MessageService, PreferenceScope, PreferenceService } from '@theia/core';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { QuickInputService, QuickPickItem } from '@theia/core/lib/common/quick-pick-service';
import { ReasoningLevel, ReasoningSupport } from '@theia/ai-core';
import { OpenAiLanguageModelsManager, OpenAiModelDescription } from '@theia/ai-openai/lib/common';
import { OLLAMA_REASONING_SUPPORT, OllamaLanguageModelsManager } from '@theia/ai-ollama/lib/common';
import { HOST_PREF as OLLAMA_HOST_PREF } from '@theia/ai-ollama/lib/common/ollama-preferences';
import { LmStudioLoadEstimate, LocalModelDiscoveryService, LocalModelInfo } from '../common/local-models-protocol.js';
import { CONTEXT_LENGTHS } from '../common/context-status.js';
import {
    LOCAL_MODELS_AUTO_DISCOVER_PREF, LOCAL_MODELS_CONTEXT_LENGTH_PREF, LOCAL_MODELS_LM_STUDIO_URL_PREF, LOCAL_MODELS_PARALLEL_PREF,
    LOCAL_MODELS_REFRESH_INTERVAL_PREF
} from './local-models-preferences.js';

export const REFRESH_LOCAL_MODELS: Command = {
    id: 'callisto.refreshLocalModels',
    category: 'Callisto',
    label: 'Refresh Local Models'
};

/** Arguments: optionally the Callisto model id (`lmstudio/<key>`) and a size to preselect. */
export const SET_CONTEXT_LENGTH: Command = {
    id: 'callisto.setModelContextLength',
    category: 'Callisto',
    label: 'Set Model Context Length…'
};

interface ContextSizeItem extends QuickPickItem {
    size: number;
}

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

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

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
        commands.registerCommand(SET_CONTEXT_LENGTH, {
            execute: (languageModelId?: string, suggested?: number) => this.chooseContextLength(languageModelId, suggested)
        });
    }

    /** The context length the user chose for LM Studio models; undefined when they left it to LM Studio. */
    get preferredContextLength(): number | undefined {
        return this.preferences.get<number>(LOCAL_MODELS_CONTEXT_LENGTH_PREF, 0) || undefined;
    }

    protected get parallel(): number {
        return Math.max(1, Math.round(this.preferences.get<number>(LOCAL_MODELS_PARALLEL_PREF, 1) ?? 1));
    }

    /**
     * Lets the user pick a context length for an LM Studio model, with LM Studio's memory estimate for each, then saves it
     * as their setting and reloads the model with it, after a confirmation (whatever the model is generating stops).
     */
    async chooseContextLength(languageModelId?: string, suggested?: number): Promise<void> {
        await this.refresh();
        const key = languageModelId?.startsWith(LM_STUDIO_PREFIX) ? languageModelId.slice(LM_STUDIO_PREFIX.length) : await this.pickLmStudioModel();
        if (!key) {
            return;
        }
        const context = this.lmStudioInfo.get(key)?.context;
        const loaded = context?.loaded;
        const max = context?.max;
        const chosen = this.preferredContextLength;
        const parallel = this.parallel;
        const sizes = [...new Set([...CONTEXT_LENGTHS.filter(size => !max || size <= max), ...[loaded, chosen, suggested, max].filter(
            (size): size is number => !!size && size <= 1_048_576)])].sort((a, b) => a - b);
        const estimates = new Map<number, LmStudioLoadEstimate>();
        const toItem = (size: number): ContextSizeItem => {
            const estimate = estimates.get(size);
            const notes = [
                size === loaded ? 'loaded now' : undefined,
                size === chosen && size !== loaded ? 'your setting' : undefined,
                size === suggested && size !== loaded ? 'suggested' : undefined,
                size === max ? 'the most this model supports' : undefined
            ].filter(Boolean).join(' · ');
            const memory = !estimate ? 'Estimating memory…'
                : estimate.gib !== undefined ? `About ${estimate.gib.toFixed(1)} GB of memory${estimate.fits === false ? ', more than LM Studio allows on this machine' : ''}`
                    : `No estimate: ${estimate.error ?? 'LM Studio did not say'}`;
            return { size, label: `${size.toLocaleString('en-US')} tokens`, description: notes, detail: memory };
        };
        const pick = this.quickInput.createQuickPick<ContextSizeItem>();
        pick.title = `Context length for ${key}`;
        pick.placeholder = 'The context window holds Callisto\'s instructions, the chat and the model\'s reasoning. Larger needs more memory.';
        const show = () => {
            const active = pick.activeItems[0]?.size ?? suggested ?? loaded ?? chosen;
            const items = sizes.map(toItem);
            pick.items = items;
            pick.activeItems = items.filter(item => item.size === active);
        };
        show();
        pick.busy = true;
        const picked = new Promise<number | undefined>(resolve => {
            pick.onDidAccept(() => {
                resolve((pick.selectedItems[0] ?? pick.activeItems[0])?.size);
                pick.hide();
            });
            pick.onDidHide(() => resolve(undefined));
        });
        pick.show();
        Promise.all(sizes.map(async size => {
            estimates.set(size, await this.discovery.estimateLmStudioLoad(key, size, parallel));
            show();
        })).finally(() => { pick.busy = false; });
        const length = await picked;
        pick.dispose();
        if (!length) {
            return;
        }
        if (length === loaded && parallel === (context?.parallel ?? parallel)) {
            await this.preferences.set(LOCAL_MODELS_CONTEXT_LENGTH_PREF, length, PreferenceScope.User);
            this.messages.info(`${key} is already loaded with a ${length.toLocaleString('en-US')}-token context. Saved it as your setting.`);
            return;
        }
        const lengthEstimate = estimates.get(length) ?? await this.discovery.estimateLmStudioLoad(key, length, parallel);
        const memoryNote = lengthEstimate.gib !== undefined ? ` It needs about ${lengthEstimate.gib.toFixed(1)} GB of memory.` : '';
        const tooBig = lengthEstimate.fits === false ? ' LM Studio estimates that this is more than it allows on this machine, so loading may fail.' : '';
        const confirmed = await new ConfirmDialog({
            title: 'Reload the model?',
            msg: `Reload ${key} with a ${length.toLocaleString('en-US')}-token context window${parallel === 1 ? '' : ` and ${parallel} parallel slots`}?${memoryNote}${tooBig} `
                + 'Whatever it is generating now stops, and the next message in each chat reads that chat again once.',
            ok: 'Reload',
            cancel: 'Cancel'
        }).open();
        if (!confirmed) {
            return;
        }
        await this.preferences.set(LOCAL_MODELS_CONTEXT_LENGTH_PREF, length, PreferenceScope.User);
        const progress = await this.messages.showProgress({ text: `Reloading ${key} with a ${length.toLocaleString('en-US')}-token context…` });
        try {
            const result = await this.discovery.reloadLmStudioModel(key, length, parallel);
            await this.refresh();
            if (result.ok) {
                this.messages.info(`${key} is loaded with a ${length.toLocaleString('en-US')}-token context.`);
            } else {
                this.messages.error(`Could not reload ${key}: ${result.error}`);
            }
        } finally {
            progress.cancel();
        }
    }

    /** The LM Studio model to change: the only loaded one, or the user's pick (loaded models first). */
    protected async pickLmStudioModel(): Promise<string | undefined> {
        const models = [...this.lmStudioInfo.values()];
        const loaded = models.filter(model => model.context?.loaded);
        if (loaded.length === 1) {
            return loaded[0].id;
        }
        const items = [...loaded, ...models.filter(model => !model.context?.loaded)].map(model => ({
            id: model.id,
            label: model.id,
            description: model.context?.loaded ? `loaded with ${model.context.loaded.toLocaleString('en-US')} tokens` : 'not loaded'
        }));
        if (items.length === 0) {
            this.messages.warn('LM Studio lists no chat models. Is it running?');
            return undefined;
        }
        return (await this.quickInput.showQuickPick(items, { placeholder: 'Which LM Studio model?' }))?.id;
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
