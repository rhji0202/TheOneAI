import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { EventsModule } from './events/events.module.js';
import { HealthController } from './health/health.controller.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { QueueModule } from './infrastructure/queue/queue.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { SecretsModule } from './infrastructure/secrets/secrets.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { ToolsModule } from './tools/tools.module.js';
import { WidgetModule } from './widget/widget.module.js';

/** API 서버. Agent 실행은 하지 않는다 (WorkerModule 이 담당). */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    SecretsModule,
    QueueModule,
    EventsModule,
    ToolsModule,
    WidgetModule,
    ConversationsModule,
    TasksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
