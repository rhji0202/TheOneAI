import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module.js';
import { EventsModule } from './events/events.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { QueueModule } from './infrastructure/queue/queue.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { WorkersModule } from './workers/workers.module.js';

/** Agent Worker 프로세스 (HTTP 없음). API 와 별도로 수평 확장한다. */
@Module({
  imports: [AppConfigModule, DatabaseModule, RedisModule, QueueModule, EventsModule, WorkersModule],
})
export class WorkerModule {}
