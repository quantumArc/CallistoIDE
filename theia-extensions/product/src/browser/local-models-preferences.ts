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
        }
    }
};
