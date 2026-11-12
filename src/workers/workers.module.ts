import { Module } from '@nestjs/common';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module.js';
import { ApprovalExpiryProcessor } from './approval-expiry.processor.js';
import { ApprovalExpiryService } from './approval-expiry.service.js';
import { MetricsRollupProcessor } from './metrics-rollup.processor.js';
import { MetricsRollupService } from './metrics-rollup.service.js';
import { AgentTaskProcessor } from './agent-task.processor.js';
import { MemoryIngestService } from '../memory/memory-ingest.service.js';
import { McpSyncProcessor } from './mcp-sync.processor.js';
import { MemoryIngestProcessor } from './memory-ingest.processor.js';
import { TaskExecutionService } from './task-execution.service.js';
import { TaskRecoveryProcessor } from './task-recovery.processor.js';
import { TaskRecoveryService } from './task-recovery.service.js';

@Module({
  imports: [AgentRuntimeModule, ApprovalsCoreModule],
  providers: [
    TaskExecutionService,
    TaskRecoveryService,
    AgentTaskProcessor,
    McpSyncProcessor,
    TaskRecoveryProcessor,
    MemoryIngestService,
    MemoryIngestProcessor,
    ApprovalExpiryService,
    ApprovalExpiryProcessor,
    MetricsRollupService,
    MetricsRollupProcessor,
  ],
  exports: [
    TaskExecutionService,
    TaskRecoveryService,
    MemoryIngestService,
    ApprovalExpiryService,
    MetricsRollupService,
  ],
})
export class WorkersModule {}
