import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
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
}
