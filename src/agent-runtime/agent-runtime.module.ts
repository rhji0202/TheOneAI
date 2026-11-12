import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { EvaluatorService } from '../evaluator/evaluator.service.js';
import { LlmModule } from '../llm/llm.module.js';
import { PlannerService } from '../planner/planner.service.js';
import { AgentLoopRuntime } from './agent-loop.runtime.js';
import { AGENT_RUNTIME, type AgentRuntime } from './agent-runtime.js';
import { ContextBuilder } from './context-builder.js';
import { ContextCompressor } from './context-compressor.js';
import { ExecutorService } from './executor.service.js';
import { ModelRouterFactory } from './model-router.js';
import { PlaceholderAgentRuntime } from './placeholder-agent-runtime.js';

@Module({
  imports: [LlmModule],
  providers: [
    ModelRouterFactory,
    ContextCompressor,
    ContextBuilder,
    PlannerService,
    ExecutorService,
    EvaluatorService,
    AgentLoopRuntime,
    PlaceholderAgentRuntime,
    {
      provide: AGENT_RUNTIME,
      inject: [APP_CONFIG, AgentLoopRuntime, PlaceholderAgentRuntime],
      useFactory: (
        config: AppConfig,
        loop: AgentLoopRuntime,
        placeholder: PlaceholderAgentRuntime,
      ): AgentRuntime => (config.agentRuntime === 'placeholder' ? placeholder : loop),
    },
  ],
  exports: [AGENT_RUNTIME, ModelRouterFactory],
})
export class AgentRuntimeModule {}
