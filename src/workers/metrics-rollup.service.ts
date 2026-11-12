import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service.js';

/** metrics-rollup — 최근 이틀(UTC)의 일별 지표를 다시 계산한다 (늦게 끝난 작업 · 복구까지 반영) */
@Injectable()
export class MetricsRollupService {
  constructor(private readonly prisma: PrismaService) {}

  async tick(days = 2): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ rows: number }>>`
      SELECT app_rollup_metrics((now() AT TIME ZONE 'UTC')::date - ${days - 1}::int) AS rows`;
    return Number(row?.rows ?? 0);
  }
}
