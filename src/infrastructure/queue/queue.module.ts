import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import {
  AGENT_RECOVERY_QUEUE,
  AGENT_TASKS_QUEUE,
  MCP_SYNC_QUEUE,
  MEMORY_INGEST_QUEUE,
} from './queues.js';
import { TaskQueueService } from './task-queue.service.js';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        // Worker 의 blocking 명령을 위해 maxRetriesPerRequest 는 null 이어야 한다.
        connection: { url: config.redisUrl, maxRetriesPerRequest: null },
        defaultJobOptions: {
          attempts: 1, // 재시도는 Agent Loop 안에서 단계 단위로 처리한다.
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 5_000 },
        },
      }),
    }),
    BullModule.registerQueue(
      { name: AGENT_TASKS_QUEUE },
      { name: MCP_SYNC_QUEUE },
      { name: AGENT_RECOVERY_QUEUE },
      { name: MEMORY_INGEST_QUEUE },
    ),
  ],
  providers: [TaskQueueService],
  exports: [BullModule, TaskQueueService],
})
export class QueueModule {}
