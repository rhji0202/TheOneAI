import { Module } from '@nestjs/common';
import { AGENT_RUNTIME } from './agent-runtime.js';
import { PlaceholderAgentRuntime } from './placeholder-agent-runtime.js';

@Module({
  providers: [{ provide: AGENT_RUNTIME, useClass: PlaceholderAgentRuntime }],
  exports: [AGENT_RUNTIME],
})
export class AgentRuntimeModule {}
