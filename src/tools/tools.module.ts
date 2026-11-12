import { Global, Module } from '@nestjs/common';
import { BuiltinToolCatalog } from './builtin-tool.catalog.js';
import { ToolAvailabilityService } from './tool-availability.service.js';
import { ToolDispatcherService } from './tool-dispatcher.service.js';
import { ToolPermissionService } from './tool-permission.service.js';
import { ToolRegistryService } from './tool-registry.service.js';

/** API(작업 생성 시 Registry 버전 고정)와 Worker(실행) 양쪽에서 쓴다. */
@Global()
@Module({
  providers: [
    BuiltinToolCatalog,
    ToolRegistryService,
    ToolPermissionService,
    ToolAvailabilityService,
    ToolDispatcherService,
  ],
  exports: [
    BuiltinToolCatalog,
    ToolRegistryService,
    ToolPermissionService,
    ToolAvailabilityService,
    ToolDispatcherService,
  ],
})
export class ToolsModule {}
