import { Module } from '@nestjs/common';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
import { AgentTaskProcessor } from './agent-task.processor.js';
import { TaskExecutionService } from './task-execution.service.js';

@Module({
  imports: [AgentRuntimeModule],
  providers: [TaskExecutionService, AgentTaskProcessor],
})
export class WorkersModule {}
