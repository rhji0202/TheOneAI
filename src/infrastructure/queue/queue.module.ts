import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { AGENT_TASKS_QUEUE } from './queues.js';

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
    BullModule.registerQueue({ name: AGENT_TASKS_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
