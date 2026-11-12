import { Module } from '@nestjs/common';
import { MemoriesAdminModule } from './memory/admin/memories-admin.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { BillingModule } from './billing/billing.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { MemoryModule } from './memory/memory.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { SkillsAdminModule } from './skills/admin/skills-admin.module.js';
import { SkillsModule } from './skills/skills.module.js';
import { AgentsAdminModule } from './agents/admin/agents-admin.module.js';
import { McpAdminModule } from './mcp/admin/mcp-admin.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { AdminCoreModule } from './admin/admin-core.module.js';
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
    StorageModule,
    QueueModule,
    EventsModule,
    ToolsModule,
    MemoryModule,
    SkillsModule,
    SkillsAdminModule,
    McpModule,
    McpAdminModule,
    WidgetModule,
    ConversationsModule,
    TasksModule,
    AdminCoreModule,
    AgentsAdminModule,
    MemoriesAdminModule,
    ApprovalsModule,
    BillingModule,
    MetricsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
