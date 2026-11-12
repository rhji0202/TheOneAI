import { Module } from '@nestjs/common';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { AgentTaskProcessor } from './agent-task.processor.js';
import { McpSyncProcessor } from './mcp-sync.processor.js';
import { TaskExecutionService } from './task-execution.service.js';

@Module({
  imports: [AgentRuntimeModule],
  providers: [TaskExecutionService, AgentTaskProcessor, McpSyncProcessor],
})
export class WorkersModule {}
