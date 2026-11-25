/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatResponseModel, CompactionChatResponseContent, ResponseTokenUsage } from '@theia/ai-chat/lib/common/chat-model';
import { CALLISTO_SUMMARY_PROVIDER, isCallistoSummaryData } from '../common/conversation-summary.js';
import { contextStatus } from '../common/context-status.js';
import { AiRunStatsService } from './ai-run-stats.js';
import { LocalModelsContribution, SET_CONTEXT_LENGTH } from './local-models-contribution.js';

const STATUS_BAR_ID = 'callisto-context-window';

/**
 * Shows how full the active chat's context window is, measured by the exact token counts LM Studio reports for each
 * model call, against the context length the model is loaded with. Updates live while the agent works.
 */
@injectable()
export class ContextStatusContribution implements FrontendApplicationContribution {

    @inject(ChatService)
    protected readonly chatService: ChatService;

    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    @inject(AiRunStatsService)
    protected readonly runStats: AiRunStatsService;

    @inject(LocalModelsContribution)
    protected readonly localModels: LocalModelsContribution;

    protected readonly toDispose = new DisposableCollection();
    /** Listens to the active chat, which changes on its own when Callisto adds a summary after a reply. */
    protected readonly activeSessionListener = new DisposableCollection();

    onStart(): void {
        this.toDispose.pushAll([
            this.activeSessionListener,
            this.chatService.onSessionEvent(() => {
                this.watchActiveSession();
                this.update();
            }),
            this.runStats.onDidChange(() => this.update()),
            this.localModels.onDidChangeLmStudioInfo(() => this.update())
        ]);
        this.watchActiveSession();
        this.update();
    }

    protected watchActiveSession(): void {
        this.activeSessionListener.dispose();
        const model = this.chatService.getActiveSession()?.model;
        if (model) {
            this.activeSessionListener.push(model.onDidChange(() => this.update()));
        }
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected update(): void {
        const latest = this.latestUsage();
        if (!latest) {
            this.statusBar.removeElement(STATUS_BAR_ID);
            return;
        }
        if (latest.summarizedFrom !== undefined) {
            const from = latest.summarizedFrom ? ` at ${latest.summarizedFrom.toLocaleString('en-US')} tokens` : '';
            this.statusBar.setElement(STATUS_BAR_ID, {
                text: '$(fold) ctx summarized',
                tooltip: `Callisto summarized this chat${from}. The next request sends the summary instead of the messages it covers, `
                    + 'and this shows its exact size once it has run.',
                alignment: StatusBarAlignment.LEFT,
                priority: 99,
                command: SET_CONTEXT_LENGTH.id,
                arguments: [latest.model]
            });
            return;
        }
        const info = this.localModels.getLmStudioInfo(latest.model);
        const preferred = this.localModels.preferredContextLength;
        const status = contextStatus({
            usedTokens: latest.usage.inputTokens + latest.usage.outputTokens,
            loadedContext: info?.context?.loaded,
            maxContext: info?.context?.max,
            model: latest.model?.replace(/^lmstudio\//, ''),
            preferredContext: info?.context?.loaded ? preferred : undefined
        });
        this.statusBar.setElement(STATUS_BAR_ID, {
            text: status.text,
            tooltip: status.tooltip,
            alignment: StatusBarAlignment.LEFT,
            priority: 99,
            backgroundColor: status.level === 'full' ? 'var(--theia-statusBarItem-errorBackground)'
                : status.level === 'warn' ? 'var(--theia-statusBarItem-warningBackground)' : undefined,
            color: status.level === 'full' ? 'var(--theia-statusBarItem-errorForeground)'
                : status.level === 'warn' ? 'var(--theia-statusBarItem-warningForeground)' : undefined,
            // A click opens the context-length picker for this model, with the user's own setting preselected
            // when LM Studio has the model loaded with another length.
            command: SET_CONTEXT_LENGTH.id,
            arguments: [latest.model, preferred !== info?.context?.loaded ? preferred : undefined]
        });
    }

    /**
     * The token usage of the active chat's most recent model call, and the model that made it; or, when Callisto has
     * summarized the chat since, the size the chat had then (`summarizedFrom`, 0 when unknown).
     */
    protected latestUsage(): { usage: ResponseTokenUsage; model?: string; summarizedFrom?: number } | undefined {
        const requests = this.chatService.getActiveSession()?.model.getRequests() ?? [];
        for (let i = requests.length - 1; i >= 0; i--) {
            const response = requests[i].response;
            const summary = response.response.content.find(part => CompactionChatResponseContent.is(part) && part.provider === CALLISTO_SUMMARY_PROVIDER);
            if (summary && CompactionChatResponseContent.is(summary)) {
                const tokensBefore = isCallistoSummaryData(summary.data) ? summary.data.tokensBefore : undefined;
                return { usage: { inputTokens: 0, outputTokens: 0 }, model: response.languageModel, summarizedFrom: tokensBefore ?? 0 };
            }
            const entries = usageEntries(response);
            const last = entries[entries.length - 1];
            if (last && last.inputTokens > 0) {
                return { usage: last, model: response.languageModel };
            }
        }
        return undefined;
    }
}

/** Theia's response keeps the usage of every model call, but its interface exposes only the latest. */
function usageEntries(response: ChatResponseModel): readonly ResponseTokenUsage[] {
    const entries = (response as { tokenUsageEntries?: readonly ResponseTokenUsage[] }).tokenUsageEntries;
    return entries ?? (response.tokenUsage ? [response.tokenUsage] : []);
}
