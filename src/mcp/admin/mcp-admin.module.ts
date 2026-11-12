import { Module } from '@nestjs/common';
import { McpAdminController } from './mcp-admin.controller.js';
import { McpAdminService } from './mcp-admin.service.js';

/** Admin API: MCP 서버 · Tool · Registry 버전 (API 프로세스 전용) */
@Module({
  controllers: [McpAdminController],
  providers: [McpAdminService],
})
export class McpAdminModule {}
