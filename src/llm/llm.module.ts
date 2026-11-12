import { Module } from '@nestjs/common';
import { LlmClientFactory } from './llm-client.factory.js';

@Module({
  providers: [LlmClientFactory],
  exports: [LlmClientFactory],
})
export class LlmModule {}
