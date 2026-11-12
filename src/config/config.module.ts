import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './app-config.js';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
