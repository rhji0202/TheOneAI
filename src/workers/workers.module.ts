import { Module } from '@nestjs/common';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { AgentTaskProcessor } from './agent-task.processor.js';
import { MemoryIngestService } from '../memory/memory-ingest.service.js';
import { McpSyncProcessor } from './mcp-sync.processor.js';
import { MemoryIngestProcessor } from './memory-ingest.processor.js';
import { TaskExecutionService } from './task-execution.service.js';
import { TaskRecoveryProcessor } from './task-recovery.processor.js';
import { TaskRecoveryService } from './task-recovery.service.js';

@Module({
  imports: [AgentRuntimeModule],
  providers: [
    TaskExecutionService,
    TaskRecoveryService,
    AgentTaskProcessor,
    McpSyncProcessor,
    TaskRecoveryProcessor,
    MemoryIngestService,
    MemoryIngestProcessor,
  ],
  exports: [TaskExecutionService, TaskRecoveryService, MemoryIngestService],
})
export class WorkersModule {}
