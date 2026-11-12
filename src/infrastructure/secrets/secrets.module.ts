import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { LocalSecretStore, SecretStore } from './secret-store.js';

@Global()
@Module({
  providers: [
    {
      provide: SecretStore,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SecretStore =>
        new LocalSecretStore(config.secrets.devSecrets, config.secrets.localFile),
    },
  ],
  exports: [SecretStore],
})
export class SecretsModule {}
