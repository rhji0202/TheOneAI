import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { SerializedPrismaPg } from './serialized-pg-adapter.js';

/** 테넌트 컨텍스트가 설정된 트랜잭션 클라이언트. */
export type TenantTx = Prisma.TransactionClient;

/**
 * 애플리케이션 DB 클라이언트 (app_rw 역할 계정).
 *
 * 테넌트 데이터는 RLS(FORCE)로 보호되므로 반드시 withTenant() 안에서 읽고 쓴다.
 * 컨텍스트 없이 테넌트 테이블을 조회하면 0행이 반환된다 (fail-closed).
 * 테넌트가 정해지기 전에 필요한 조회는 SECURITY DEFINER 함수(app_resolve_*)로만 한다.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new SerializedPrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  withTenant<T>(
    tenantId: string,
    fn: (tx: TenantTx) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      { timeout: options?.timeoutMs ?? 10_000 },
    );
  }
}
