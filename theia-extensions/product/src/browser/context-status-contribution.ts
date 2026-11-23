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
import { ChatResponseModel, ResponseTokenUsage } from '@theia/ai-chat/lib/common/chat-model';
import { contextStatus } from '../common/context-status.js';
import { AiRunStatsService } from './ai-run-stats.js';
import { LocalModelsContribution, REFRESH_LOCAL_MODELS } from './local-models-contribution.js';

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

    onStart(): void {
        this.toDispose.pushAll([
            this.chatService.onSessionEvent(() => this.update()),
            this.runStats.onDidChange(() => this.update()),
            this.localModels.onDidChangeLmStudioInfo(() => this.update())
        ]);
        this.update();
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
        const info = this.localModels.getLmStudioInfo(latest.model);
        const status = contextStatus({
            usedTokens: latest.usage.inputTokens + latest.usage.outputTokens,
            loadedContext: info?.context?.loaded,
            maxContext: info?.context?.max,
            model: latest.model?.replace(/^lmstudio\//, '')
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
            command: REFRESH_LOCAL_MODELS.id
        });
    }

    /** The token usage of the active chat's most recent model call, and the model that made it. */
    protected latestUsage(): { usage: ResponseTokenUsage; model?: string } | undefined {
        const requests = this.chatService.getActiveSession()?.model.getRequests() ?? [];
        for (let i = requests.length - 1; i >= 0; i--) {
            const response = requests[i].response;
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
