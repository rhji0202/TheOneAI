import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap/configure-app.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';

const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));
const config = app.get<AppConfig>(APP_CONFIG);
await app.listen(config.port);
new Logger('Bootstrap').log(`API 서버 시작: http://localhost:${config.port} (${config.env})`);
