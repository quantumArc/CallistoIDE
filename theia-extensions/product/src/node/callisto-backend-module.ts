/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { LOCAL_MODEL_DISCOVERY_PATH, LocalModelDiscoveryService } from '../common/local-models-protocol.js';
import { LocalModelDiscoveryServiceImpl } from './local-model-discovery-service.js';
import { ChatCompletionStreamingAsyncIterator } from '@theia/ai-openai/lib/node/openai-chat-completion-stream';
import { OpenAiModelUtils } from '@theia/ai-openai/lib/node/openai-model-utils';
import { CallistoChatCompletionStream, CallistoOpenAiModelUtils } from './callisto-chat-completion-stream.js';
import { SYNTAX_CHECK_PATH, SyntaxCheckService } from '../common/syntax-check-protocol.js';
import { SyntaxCheckServiceImpl } from './syntax-check-service.js';
import { installLocalModelTimeouts } from './local-model-timeouts.js';

// Long prompts on a local model take minutes before the first byte; do not let fetch give up after 5 (see the function).
installLocalModelTimeouts();

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
    bind(LocalModelDiscoveryServiceImpl).toSelf().inSingletonScope();
    bind(LocalModelDiscoveryService).toService(LocalModelDiscoveryServiceImpl);
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(LOCAL_MODEL_DISCOVERY_PATH, () => ctx.container.get(LocalModelDiscoveryService))
    ).inSingletonScope();

    bind(SyntaxCheckServiceImpl).toSelf().inSingletonScope();
    bind(SyntaxCheckService).toService(SyntaxCheckServiceImpl);
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(SYNTAX_CHECK_PATH, () => ctx.container.get(SyntaxCheckService))
    ).inSingletonScope();

    // OpenAI-compatible tool loop that keeps the model's reasoning between tool steps (see the class).
    // @theia/ai-openai's backend module is loaded before this one, since this package depends on it.
    if (isBound(ChatCompletionStreamingAsyncIterator)) {
        rebind(ChatCompletionStreamingAsyncIterator).to(CallistoChatCompletionStream).inTransientScope();
    } else {
        bind(ChatCompletionStreamingAsyncIterator).to(CallistoChatCompletionStream).inTransientScope();
    }
    // ...and rebuilds that reasoning from the chat history the same way, so LM Studio's prompt cache keeps matching.
    if (isBound(OpenAiModelUtils)) {
        rebind(OpenAiModelUtils).to(CallistoOpenAiModelUtils).inSingletonScope();
    } else {
        bind(OpenAiModelUtils).to(CallistoOpenAiModelUtils).inSingletonScope();
    }
});
