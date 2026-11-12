import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DEFAULT_BUILTIN_TOOLS } from './builtin/builtin-tools.js';
import { TOOL_NAME_PATTERN } from './tool-names.js';
import type { BuiltinTool, SnapshotTool } from './tool.types.js';

/**
 * 내장 Tool 목록. 배포된 코드가 곧 버전이므로, 구성이 바뀌면 hash() 가 달라지고
 * 다음 작업을 만들 때 새 Registry 버전이 생긴다 (ToolRegistryService.ensureCurrentVersion).
 */
@Injectable()
export class BuiltinToolCatalog {
  private readonly tools = new Map<string, BuiltinTool>();

  constructor() {
    for (const tool of DEFAULT_BUILTIN_TOOLS) this.register(tool);
  }

  /** 확장 · 테스트용 등록 */
  register(tool: BuiltinTool): void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`Tool 이름 형식 오류: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): BuiltinTool | undefined {
    return this.tools.get(name);
  }

  snapshotTools(): SnapshotTool[] {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => {
        const inputSchema = toJsonSchema(tool.input);
        return {
          name: tool.name,
          source: 'builtin' as const,
          description: tool.description,
          inputSchema,
          schemaHash: sha256(
            JSON.stringify({ d: tool.description, s: inputSchema, l: tool.level }),
          ),
          level: tool.level,
          modeOverride: null,
        };
      });
  }

  hash(): string {
    return sha256(JSON.stringify(this.snapshotTools().map((t) => [t.name, t.schemaHash])));
  }
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return rest;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
