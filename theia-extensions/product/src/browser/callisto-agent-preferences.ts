/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AI_CORE_PREFERENCES_TITLE } from '@theia/ai-core/lib/common/ai-core-preferences';
import { PreferenceSchema } from '@theia/core/lib/common';

export const LOOP_BREAKER_PREF = 'callisto.agent.loopBreaker';
export const MAX_THINKING_TOKENS_PREF = 'callisto.agent.maxThinkingTokens';

export const CallistoAgentPreferencesSchema: PreferenceSchema = {
    properties: {
        [LOOP_BREAKER_PREF]: {
            type: 'boolean',
            title: AI_CORE_PREFERENCES_TITLE,
            default: true,
            markdownDescription: 'Let the Callisto agent interrupt a model whose reasoning goes in circles (the same checks over and over) '
                + 'or runs far longer than choosing the next step needs, and resume it with a nudge to act. '
                + 'Everything done so far in the task is kept; only the looping reasoning is dropped.'
        },
        [MAX_THINKING_TOKENS_PREF]: {
            type: 'number',
            title: AI_CORE_PREFERENCES_TITLE,
            default: 16000,
            minimum: 0,
            markdownDescription: 'Longest single stretch of reasoning, in tokens, before the Callisto agent asks the model to act. '
                + 'At about 33 tokens per second, 16000 is about 8 minutes on a local model. `0` turns this limit off '
                + '(repetition is still caught while `#callisto.agent.loopBreaker#` is on).'
        }
    }
};
