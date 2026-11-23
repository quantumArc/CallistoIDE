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
            markdownDescription: 'Let the Callisto agent interrupt a model whose reasoning goes in circles (the same points over and over) '
                + 'or is about to fill the context window, and resume it with a nudge to act. Everything done so far in the task is kept, '
                + 'and so is the reasoning before the loop began.'
        },
        [MAX_THINKING_TOKENS_PREF]: {
            type: 'number',
            title: AI_CORE_PREFERENCES_TITLE,
            default: 0,
            minimum: 0,
            markdownDescription: 'Longest single stretch of reasoning, in tokens, before the Callisto agent asks the model to act. '
                + '`0` (the default) sets no limit of its own: the model may think as long as it needs, up to the room left in the context '
                + 'window. Reasoning models often plan for a long time and then act; interrupting them early tends to make them plan again. '
                + 'Repetition is caught either way while `#callisto.agent.loopBreaker#` is on.'
        }
    }
};
