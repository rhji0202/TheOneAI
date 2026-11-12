import { Module } from '@nestjs/common';
import { WidgetConfigsAdminController } from './widget-configs-admin.controller.js';
import { WidgetConfigsAdminService } from './widget-configs-admin.service.js';

@Module({
  controllers: [WidgetConfigsAdminController],
  providers: [WidgetConfigsAdminService],
})
export class WidgetAdminModule {}
