import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { WorkerModule } from './worker.module.js';

const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
const config = app.get<AppConfig>(APP_CONFIG);
new Logger('Worker').log(
  `Agent Worker 시작 (동시 실행 ${config.worker.concurrency}, ${config.env})`,
);
