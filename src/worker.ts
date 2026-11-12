import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { AgentTaskProcessor } from './workers/agent-task.processor.js';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule);
const logger = new Logger('Worker');

// 종료 신호: 새 Job 을 멈추고, 실행 중 작업은 checkpoint 기준으로 recovering 에 넘긴 뒤 닫는다
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.log(`${signal} — 실행 중 작업을 넘기고 종료합니다`);
    void (async () => {
      try {
        await app.get(AgentTaskProcessor).stop();
        await app.close();
      } finally {
        process.exit(0);
      }
    })();
  });
}
const config = app.get<AppConfig>(APP_CONFIG);
logger.log(`Agent Worker 시작 (동시 실행 ${config.worker.concurrency}, ${config.env})`);
