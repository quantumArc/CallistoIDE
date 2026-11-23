/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { Disposable, DisposableCollection, Emitter, Event } from '@theia/core';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import {
    ChatModel, ChatResponseContent, ChatResponseModel, ResponseTokenUsage, ThinkingChatResponseContent, ToolCallChatResponseContent
} from '@theia/ai-chat/lib/common/chat-model';

/** What the agent is doing right now, from the last part of its response. */
export type AiRunPhase = 'Reading prompt' | 'Thinking' | 'Writing' | 'Running tool' | 'Waiting for you' | 'Done' | 'Stopped' | 'Failed';

export interface AiRunStats {
    phase: AiRunPhase;
    /** Name of the tool being run, when the phase is 'Running tool'. */
    toolName?: string;
    elapsedMs: number;
    /** Output tokens so far: exact for finished model calls, estimated for the call still streaming. */
    tokens: number;
    /** True when part of `tokens` is still an estimate. */
    estimated: boolean;
    /** Output tokens per second over the last few seconds, or the run's average once it has finished. */
    tokensPerSecond: number | undefined;
    model?: string;
    active: boolean;
}

/** Window over which the live speed is measured. Long enough to smooth out bursts, short enough to follow changes. */
const RATE_WINDOW_MS = 5000;
const TICK_MS = 1000;
/** Starting guess for characters per token, refined from the exact counts after every model call. */
const DEFAULT_CHARS_PER_TOKEN = 3;
const CHARS_PER_TOKEN_STORAGE_KEY = 'callisto.aiRunStats.charsPerToken';
const STATUS_BAR_ID = 'callisto-ai-run-stats';

interface Run {
    response: ChatResponseModel;
    start: number;
    end?: number;
    /** Streamed characters when the last exact token count arrived. */
    charsAtLastUsage: number;
    usageEntriesSeen: number;
    samples: { time: number; tokens: number }[];
}

/**
 * Times every chat request and measures its output speed, like the status line of a terminal coding agent.
 * The stats are shown next to 'Thinking' in the chat and, for the whole run, in the status bar.
 */
@injectable()
export class AiRunStatsService implements FrontendApplicationContribution {

    @inject(ChatService)
    protected readonly chatService: ChatService;

    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    /** Fires about once a second while a run is active, and when a run starts or ends. */
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    protected readonly runs = new Map<string, Run>();
    protected readonly watchedSessions = new Set<string>();
    protected readonly toDispose = new DisposableCollection();
    protected lastRun: Run | undefined;
    protected timer: ReturnType<typeof setInterval> | undefined;
    protected charsPerToken = DEFAULT_CHARS_PER_TOKEN;

    onStart(): void {
        this.charsPerToken = this.loadCharsPerToken();
        this.chatService.getSessions().forEach(session => this.watchModel(session.id, session.model));
        this.toDispose.push(this.chatService.onSessionEvent(event => {
            if (event.type === 'created') {
                const session = this.chatService.getSession(event.sessionId);
                if (session) {
                    this.watchModel(session.id, session.model);
                }
            }
        }));
    }

    onStop(): void {
        this.stopTimer();
        this.toDispose.dispose();
    }

    /** Stats of the run that produced `responseId`, if it was started in this window. */
    getStats(responseId: string): AiRunStats | undefined {
        const run = this.runs.get(responseId);
        return run && this.computeStats(run);
    }

    protected watchModel(sessionId: string, model: ChatModel): void {
        if (this.watchedSessions.has(sessionId)) {
            return;
        }
        this.watchedSessions.add(sessionId);
        this.toDispose.push(model.onDidChange(event => {
            if (event.kind === 'addRequest') {
                this.startRun(event.request.response);
            }
        }));
    }

    protected startRun(response: ChatResponseModel): void {
        const run: Run = { response, start: Date.now(), charsAtLastUsage: 0, usageEntriesSeen: 0, samples: [] };
        this.runs.set(response.id, run);
        this.lastRun = run;
        const listener = response.onDidChange(() => this.onResponseChanged(run, listener));
        this.toDispose.push(listener);
        this.startTimer();
        this.update();
    }

    protected onResponseChanged(run: Run, listener: Disposable): void {
        this.learnCharsPerToken(run);
        if (!run.end && this.isFinished(run.response)) {
            run.end = Date.now();
            listener.dispose();
            this.update();
            if (![...this.runs.values()].some(r => !r.end)) {
                this.stopTimer();
            }
        }
    }

    /**
     * Each finished model call adds an exact token count; the characters streamed during that call give the
     * model's characters per token, which keeps the live estimate close for the next call.
     */
    protected learnCharsPerToken(run: Run): void {
        const entries = usageEntries(run.response);
        while (run.usageEntriesSeen < entries.length) {
            const outputTokens = entries[run.usageEntriesSeen++].outputTokens;
            const chars = this.countChars(run.response);
            const streamed = chars - run.charsAtLastUsage;
            run.charsAtLastUsage = chars;
            if (outputTokens >= 50 && streamed > 0) {
                const sample = Math.min(8, Math.max(1.5, streamed / outputTokens));
                this.charsPerToken = this.charsPerToken * 0.5 + sample * 0.5;
                this.saveCharsPerToken();
            }
        }
    }

    protected computeStats(run: Run): AiRunStats {
        const now = run.end ?? Date.now();
        const response = run.response;
        const exact = usageEntries(response).reduce((sum, entry) => sum + entry.outputTokens, 0);
        const pendingChars = Math.max(0, this.countChars(response) - run.charsAtLastUsage);
        const estimate = Math.round(pendingChars / this.charsPerToken);
        const tokens = exact + estimate;
        const elapsedMs = now - run.start;
        const { phase, toolName } = this.phaseOf(run);

        let tokensPerSecond: number | undefined;
        if (run.end) {
            tokensPerSecond = elapsedMs > 0 && tokens > 0 ? tokens / (elapsedMs / 1000) : undefined;
        } else {
            const windowStart = run.samples.find(sample => sample.time >= now - RATE_WINDOW_MS);
            if (windowStart && now - windowStart.time >= 1000 && tokens > windowStart.tokens) {
                tokensPerSecond = (tokens - windowStart.tokens) / ((now - windowStart.time) / 1000);
            }
        }
        return {
            phase, toolName, elapsedMs, tokens, estimated: estimate > 0, tokensPerSecond,
            model: response.languageModel, active: !run.end
        };
    }

    protected phaseOf(run: Run): { phase: AiRunPhase; toolName?: string } {
        const response = run.response;
        if (run.end) {
            return { phase: response.isError ? 'Failed' : response.isCanceled ? 'Stopped' : 'Done' };
        }
        if (response.isWaitingForInput) {
            return { phase: 'Waiting for you' };
        }
        const parts = response.response.content;
        const last = parts[parts.length - 1];
        if (!last) {
            return { phase: 'Reading prompt' };
        }
        if (ThinkingChatResponseContent.is(last)) {
            return { phase: 'Thinking' };
        }
        if (ToolCallChatResponseContent.is(last)) {
            // A finished tool call means its result is being read back into the model.
            return last.finished ? { phase: 'Reading prompt' } : { phase: 'Running tool', toolName: last.name };
        }
        return { phase: 'Writing' };
    }

    /** Characters the model has produced so far: reasoning, answer text and tool-call arguments. */
    protected countChars(response: ChatResponseModel): number {
        return response.response.content.reduce((sum, part) => sum + this.charsOf(part), 0);
    }

    protected charsOf(part: ChatResponseContent): number {
        if (ThinkingChatResponseContent.is(part)) {
            return part.content.length;
        }
        if (ToolCallChatResponseContent.is(part)) {
            return part.arguments?.length ?? 0;
        }
        return part.asString?.()?.length ?? 0;
    }

    protected isFinished(response: ChatResponseModel): boolean {
        return response.isComplete || response.isCanceled || response.isError;
    }

    protected startTimer(): void {
        this.timer ??= setInterval(() => this.update(), TICK_MS);
    }

    protected stopTimer(): void {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    protected update(): void {
        const now = Date.now();
        for (const run of this.runs.values()) {
            if (!run.end) {
                const stats = this.computeStats(run);
                run.samples.push({ time: now, tokens: stats.tokens });
                run.samples = run.samples.filter(sample => sample.time >= now - RATE_WINDOW_MS - TICK_MS);
            }
        }
        this.updateStatusBar();
        this.onDidChangeEmitter.fire();
    }

    protected updateStatusBar(): void {
        if (!this.lastRun) {
            return;
        }
        const stats = this.computeStats(this.lastRun);
        const icon = stats.active ? '$(loading~spin)' : stats.phase === 'Done' ? '$(check)' : '$(circle-slash)';
        const phase = stats.phase === 'Running tool' && stats.toolName ? `Running ${stats.toolName}` : stats.phase;
        const speed = stats.tokensPerSecond !== undefined
            ? ` · ${formatRate(stats.tokensPerSecond)}${stats.active ? '' : ' avg'}`
            : '';
        this.statusBar.setElement(STATUS_BAR_ID, {
            text: `${icon} ${phase} · ${formatDuration(stats.elapsedMs)} · ${formatTokens(stats.tokens, stats.estimated)} tokens${speed}`,
            alignment: StatusBarAlignment.LEFT,
            priority: 100,
            tooltip: (stats.active ? 'Current AI run' : 'Last AI run')
                + (stats.model ? ` (${stats.model})` : '')
                + '. Tokens are output tokens; "~" marks an estimate for text still streaming.'
        });
    }

    protected loadCharsPerToken(): number {
        try {
            const stored = Number(window.localStorage.getItem(CHARS_PER_TOKEN_STORAGE_KEY));
            return stored >= 1.5 && stored <= 8 ? stored : DEFAULT_CHARS_PER_TOKEN;
        } catch {
            return DEFAULT_CHARS_PER_TOKEN;
        }
    }

    protected saveCharsPerToken(): void {
        try {
            window.localStorage.setItem(CHARS_PER_TOKEN_STORAGE_KEY, String(this.charsPerToken));
        } catch {
            // Storage unavailable: the learned value then only lasts for this window.
        }
    }
}

/**
 * The exact token counts of every model call of a response. Theia's response implementation keeps them all, but
 * its `ChatResponseModel` interface exposes only the latest, so this falls back to that one.
 */
function usageEntries(response: ChatResponseModel): readonly ResponseTokenUsage[] {
    const entries = (response as { tokenUsageEntries?: readonly ResponseTokenUsage[] }).tokenUsageEntries;
    return entries ?? (response.tokenUsage ? [response.tokenUsage] : []);
}

export function formatDuration(ms: number): string {
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours) {
        return `${hours}h ${minutes}m`;
    }
    return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function formatTokens(tokens: number, estimated: boolean): string {
    const value = tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k` : String(tokens);
    return `${estimated ? '~' : ''}${value}`;
}

export function formatRate(tokensPerSecond: number): string {
    return `${tokensPerSecond >= 10 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} tok/s`;
}
