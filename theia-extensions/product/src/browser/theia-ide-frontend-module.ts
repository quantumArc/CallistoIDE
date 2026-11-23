/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import '../../src/browser/style/index.css';

import { AIRegistryConfiguration } from '@theia/ai-registry/lib/common/ai-registry-configuration';
import { FrontendApplicationContribution, RemoteConnectionProvider, ServiceConnectionProvider, WidgetFactory } from '@theia/core/lib/browser';
import { PreferenceContribution } from '@theia/core';
import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { applyBranding } from './theia-ide-config.js';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { GettingStartedWidget } from '@theia/getting-started/lib/browser/getting-started-widget';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { TheiaIDEAboutDialog } from './theia-ide-about-dialog.js';
import { TheiaIDEAIRegistryConfiguration } from './theia-ide-ai-registry-configuration.js';
import { TheiaIDEContribution } from './theia-ide-contribution.js';
import { TheiaIDEGettingStartedWidget } from './theia-ide-getting-started-widget.js';
import { LocalModelsContribution } from './local-models-contribution.js';
import { AiRunStatsService } from './ai-run-stats.js';
import { ContextStatusContribution } from './context-status-contribution.js';
import { CallistoAgent } from './callisto-agent.js';
import { CallistoAgentPreferencesSchema } from './callisto-agent-preferences.js';
import { SYNTAX_CHECK_PATH, SyntaxCheckService } from '../common/syntax-check-protocol.js';
import { Agent } from '@theia/ai-core/lib/common';
import { ChatAgent } from '@theia/ai-chat/lib/common';
import { CallistoThinkingPartRenderer } from './callisto-thinking-part-renderer.js';
import { CallistoNoticeRenderer } from './callisto-notice-renderer.js';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';
import { LocalModelsPreferencesSchema } from './local-models-preferences.js';
import { LOCAL_MODEL_DISCOVERY_PATH, LocalModelDiscoveryService } from '../common/local-models-protocol.js';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    applyBranding();

    bind(TheiaIDEGettingStartedWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: GettingStartedWidget.ID,
        createWidget: () => context.container.get<TheiaIDEGettingStartedWidget>(TheiaIDEGettingStartedWidget),
    })).inSingletonScope();
    if (isBound(AboutDialog)) {
        rebind(AboutDialog).to(TheiaIDEAboutDialog).inSingletonScope();
    } else {
        bind(AboutDialog).to(TheiaIDEAboutDialog).inSingletonScope();
    }

    bind(TheiaIDEContribution).toSelf().inSingletonScope();
    [CommandContribution, MenuContribution].forEach(serviceIdentifier =>
        bind(serviceIdentifier).toService(TheiaIDEContribution)
    );

    if (isBound(AIRegistryConfiguration)) {
        rebind(AIRegistryConfiguration).to(TheiaIDEAIRegistryConfiguration).inSingletonScope();
    } else {
        bind(AIRegistryConfiguration).to(TheiaIDEAIRegistryConfiguration).inSingletonScope();
    }

    // Lists every LM Studio and Ollama model in the model pickers.
    bind(PreferenceContribution).toConstantValue({ schema: LocalModelsPreferencesSchema });
    bind(LocalModelDiscoveryService).toDynamicValue(ctx =>
        ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider).createProxy<LocalModelDiscoveryService>(LOCAL_MODEL_DISCOVERY_PATH)
    ).inSingletonScope();
    bind(LocalModelsContribution).toSelf().inSingletonScope();
    [FrontendApplicationContribution, CommandContribution].forEach(serviceIdentifier =>
        bind(serviceIdentifier).toService(LocalModelsContribution)
    );

    // Elapsed time, tokens and tokens/second of AI runs: in the status bar and on the 'Thinking' line.
    bind(AiRunStatsService).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(AiRunStatsService);

    // How full the active chat's context window is, against the context length LM Studio loaded the model with.
    bind(ContextStatusContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(ContextStatusContribution);
    bind(CallistoThinkingPartRenderer).toSelf().inSingletonScope();
    bind(ChatResponsePartRenderer).toService(CallistoThinkingPartRenderer);
    bind(CallistoNoticeRenderer).toSelf().inSingletonScope();
    bind(ChatResponsePartRenderer).toService(CallistoNoticeRenderer);

    // Callisto's own coding agent, tuned for local models.
    bind(PreferenceContribution).toConstantValue({ schema: CallistoAgentPreferencesSchema });
    bind(SyntaxCheckService).toDynamicValue(ctx =>
        ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider).createProxy<SyntaxCheckService>(SYNTAX_CHECK_PATH)
    ).inSingletonScope();
    bind(CallistoAgent).toSelf().inSingletonScope();
    bind(Agent).toService(CallistoAgent);
    bind(ChatAgent).toService(CallistoAgent);
});
