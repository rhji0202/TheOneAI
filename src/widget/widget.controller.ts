import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  type BootstrapInput,
  bootstrapSchema,
  WidgetBootstrapService,
  type WidgetBootstrapResponse,
} from './widget-bootstrap.service.js';

@Controller({ path: 'widget', version: '1' })
export class WidgetController {
  constructor(private readonly bootstrapService: WidgetBootstrapService) {}

  /** W-01 · 세션 발급 + 위젯 초기 데이터 (docs/api-spec.md §2.1) */
  @Post('bootstrap')
  @HttpCode(200)
  bootstrap(
    @Body({ schema: bootstrapSchema }) body: BootstrapInput,
    @Headers('origin') origin: string | undefined,
  ): Promise<WidgetBootstrapResponse> {
    return this.bootstrapService.bootstrap(body, origin);
  }

  /** 위젯 아이콘 — 주소에 내용 해시가 있어 오래 캐시한다. 방문자 페이지(다른 출처)의 img 로 읽힌다 */
  @Get('icons/:publicKey/:sha256')
  async icon(
    @Param('publicKey', { schema: z.string().regex(/^wk_pub_[A-Za-z0-9_]{3,64}$/) })
    publicKey: string,
    @Param('sha256', { schema: z.string().regex(/^[0-9a-f]{64}$/) }) sha256: string,
    @Res() res: Response,
  ): Promise<void> {
    const { data, mimeType } = await this.bootstrapService.icon(publicKey, sha256);
    res
      .status(200)
      .set({
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Security-Policy': "default-src 'none'",
      })
      .send(data);
  }
}
