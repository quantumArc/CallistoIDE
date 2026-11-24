/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AI_CORE_PREFERENCES_TITLE } from '@theia/ai-core/lib/common/ai-core-preferences';
import { PreferenceSchema } from '@theia/core/lib/common';
import { DEFAULT_SUMMARIZE_AFTER_TOKENS, MIN_SUMMARIZE_AFTER_TOKENS } from '../common/conversation-summary.js';

export const LOOP_BREAKER_PREF = 'callisto.agent.loopBreaker';
export const MAX_THINKING_TOKENS_PREF = 'callisto.agent.maxThinkingTokens';
export const SUMMARIZE_AFTER_TOKENS_PREF = 'callisto.agent.summarizeAfterTokens';
export const WEB_SEARCH_ENABLED_PREF = 'callisto.webSearch.enabled';
export const WEB_SEARCH_URL_PREF = 'callisto.webSearch.searxngUrl';
export const WEB_SEARCH_CONTROL_SCRIPT_PREF = 'callisto.webSearch.controlScript';

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
        },
        [SUMMARIZE_AFTER_TOKENS_PREF]: {
            type: 'number',
            title: AI_CORE_PREFERENCES_TITLE,
            default: DEFAULT_SUMMARIZE_AFTER_TOKENS,
            minimum: 0,
            markdownDescription: 'Chat size, in tokens, from which the Callisto agent has a local model (LM Studio, Ollama) summarize the chat, '
                + 'and from then on sends the summary instead of the messages it covers. Every message re-sends the whole chat, and after '
                + 'LM Studio restarts or unloads the model a long chat takes minutes to read again (65,000 tokens took Inkling over 6 minutes). '
                + 'The summary is written right after the model\'s reply, while the chat is still cached, so it is quick; the chat itself stays '
                + 'visible. Callisto summarizes by half of the context the model is loaded with at the latest, and never below '
                + `${MIN_SUMMARIZE_AFTER_TOKENS.toLocaleString('en-US')} tokens. \`0\` turns summaries off.`
        },
        [WEB_SEARCH_ENABLED_PREF]: {
            type: 'boolean',
            title: AI_CORE_PREFERENCES_TITLE,
            default: true,
            markdownDescription: 'Let the Callisto agent search the web (`webSearch`) and read web pages (`fetchWebPage`) through your own '
                + '[SearXNG](https://docs.searxng.org/), a metasearch engine that runs on this Mac: no account, and your searches are not '
                + 'tied to you. Setting it up is described in `docs/web-search.md`. Each search and page read asks for your confirmation '
                + 'unless you set the tool to "Always allow".'
        },
        [WEB_SEARCH_URL_PREF]: {
            type: 'string',
            title: AI_CORE_PREFERENCES_TITLE,
            default: 'http://127.0.0.1:8888',
            markdownDescription: 'Address of the SearXNG the agent searches through. It must have the JSON format enabled '
                + '(`search.formats` in its `settings.yml`).'
        },
        [WEB_SEARCH_CONTROL_SCRIPT_PREF]: {
            type: 'string',
            title: AI_CORE_PREFERENCES_TITLE,
            default: '',
            markdownDescription: 'A script that starts and stops your SearXNG when called with `start` or `stop`, such as '
                + '`~/Documents/searxng/local/searxng.sh`. When the agent searches and nothing answers at `#callisto.webSearch.searxngUrl#`, '
                + 'Callisto runs `<script> start`, and `<script> stop` when Callisto exits; a SearXNG you started yourself is left running. '
                + 'Empty: Callisto never starts SearXNG, and the agent tells you when it is not running.'
        }
    }
};
