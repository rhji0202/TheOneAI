import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../src/worker.module.js';

/**
 * Worker 프로세스는 API 모듈 없이 WorkerModule 만으로 뜬다 (src/worker.ts).
 * 다른 e2e 는 AppModule + WorkerModule 을 함께 띄우므로, Worker 만의 의존성 누락은 여기서 잡는다.
 */
it('WorkerModule 만으로 의존성이 모두 해결된다', async () => {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });
  await app.init();
  await app.close();
});
