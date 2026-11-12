import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { LocalObjectStorage, ObjectStorage } from './object-storage.js';

@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ObjectStorage => new LocalObjectStorage(config.storage.dir),
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
