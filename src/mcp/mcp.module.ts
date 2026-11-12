import { Global, Module } from '@nestjs/common';
import { McpConnectionService } from './mcp-connection.service.js';
import { McpDiscoveryService } from './mcp-discovery.service.js';
import { McpSyncService } from './mcp-sync.service.js';

/** MCP 연결 · 탐색 (API · Worker 공통). 관리 API 는 McpAdminModule, 주기 재탐색은 Worker 의 mcp-sync */
@Global()
@Module({
  providers: [McpConnectionService, McpDiscoveryService, McpSyncService],
  exports: [McpConnectionService, McpDiscoveryService, McpSyncService],
})
export class McpModule {}
