/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AI_CORE_PREFERENCES_TITLE } from '@theia/ai-core/lib/common/ai-core-preferences';
import { PreferenceSchema } from '@theia/core/lib/common';

export const LOCAL_MODELS_AUTO_DISCOVER_PREF = 'callisto.localModels.autoDiscover';
export const LOCAL_MODELS_LM_STUDIO_URL_PREF = 'callisto.localModels.lmStudioUrl';
export const LOCAL_MODELS_REFRESH_INTERVAL_PREF = 'callisto.localModels.refreshIntervalSeconds';
export const LOCAL_MODELS_CONTEXT_LENGTH_PREF = 'callisto.localModels.contextLength';
export const LOCAL_MODELS_PARALLEL_PREF = 'callisto.localModels.parallel';

export const LocalModelsPreferencesSchema: PreferenceSchema = {
    properties: {
        [LOCAL_MODELS_AUTO_DISCOVER_PREF]: {
            type: 'boolean',
            title: AI_CORE_PREFERENCES_TITLE,
            default: true,
            markdownDescription: 'List every chat model from your local LM Studio and Ollama servers in the model pickers. '
                + 'The Ollama server is taken from `#ai-features.ollama.ollamaHost#`.'
        },
        [LOCAL_MODELS_LM_STUDIO_URL_PREF]: {
            type: 'string',
            title: AI_CORE_PREFERENCES_TITLE,
            default: 'http://localhost:1234/v1',
            markdownDescription: 'OpenAI-compatible base URL of the LM Studio server. Its models are listed as `lmstudio/<model>`.'
        },
        [LOCAL_MODELS_REFRESH_INTERVAL_PREF]: {
            type: 'number',
            title: AI_CORE_PREFERENCES_TITLE,
            default: 30,
            minimum: 0,
            markdownDescription: 'How often, in seconds, to check the local servers for added or removed models. `0` checks only at startup '
                + 'and when you run **Callisto: Refresh Local Models**.'
        },
        [LOCAL_MODELS_CONTEXT_LENGTH_PREF]: {
            type: 'number',
            title: AI_CORE_PREFERENCES_TITLE,
            default: 0,
            minimum: 0,
            markdownDescription: 'Context length, in tokens, you want LM Studio models loaded with. The context window holds Callisto\'s '
                + 'instructions, the whole chat and the model\'s reasoning, so hard tasks at a high thinking level need a large one. Set it with '
                + '**Callisto: Set Model Context Length…** (or a click on the context size in the status bar), which shows LM Studio\'s memory '
                + 'estimate and reloads the model. When LM Studio has the model loaded with another length (after it restarted, say), the '
                + 'status bar says so. `0`: whatever LM Studio loads.'
        },
        [LOCAL_MODELS_PARALLEL_PREF]: {
            type: 'number',
            title: AI_CORE_PREFERENCES_TITLE,
            default: 1,
            minimum: 1,
            maximum: 8,
            markdownDescription: 'Predictions an LM Studio model may run at once when Callisto loads it. The slots share one context window: '
                + 'with several, a chat summary and the chat it summarizes each need room in it, so a long chat\'s summary can fail. With `1` '
                + 'they take turns, and the summary reuses the chat\'s cached prompt.'
        }
    }
};
