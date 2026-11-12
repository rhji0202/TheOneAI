import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { MCP_SYNC_QUEUE } from '../infrastructure/queue/queues.js';
import { McpSyncService } from '../mcp/mcp-sync.service.js';

const SCHEDULER_ID = 'mcp-sync-tick';

/**
 * mcp-sync 큐 — MCP_SYNC_TICK_SEC 마다 재탐색 시기가 된 서버를 확인한다.
 * 스케줄러는 Redis 에 하나만 존재하므로(upsert) Worker 가 여러 개여도 한 번씩만 돈다.
 */
@Processor(MCP_SYNC_QUEUE, { concurrency: 1 })
export class McpSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(McpSyncProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectQueue(MCP_SYNC_QUEUE) private readonly queue: Queue,
    private readonly sync: McpSyncService,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    const tickSec = this.config.mcp.syncTickSec;
    if (tickSec === 0) {
      await this.queue.removeJobScheduler(SCHEDULER_ID);
      return;
    }
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: tickSec * 1_000 },
      { name: 'tick', opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } },
    );
    this.logger.log(
      `MCP 재탐색 주기 잡 등록 (확인 ${tickSec}s, 서버별 ${this.config.mcp.syncIntervalSec}s)`,
    );
  }

  async process(): Promise<{ checked: number }> {
    return { checked: await this.sync.tick() };
  }
}
