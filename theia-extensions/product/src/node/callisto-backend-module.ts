/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core';
import { LOCAL_MODEL_DISCOVERY_PATH, LocalModelDiscoveryService } from '../common/local-models-protocol.js';
import { LocalModelDiscoveryServiceImpl } from './local-model-discovery-service.js';

export default new ContainerModule(bind => {
    bind(LocalModelDiscoveryServiceImpl).toSelf().inSingletonScope();
    bind(LocalModelDiscoveryService).toService(LocalModelDiscoveryServiceImpl);
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(LOCAL_MODEL_DISCOVERY_PATH, () => ctx.container.get(LocalModelDiscoveryService))
    ).inSingletonScope();
});
