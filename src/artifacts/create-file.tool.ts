import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { BuiltinToolCatalog } from '../tools/builtin-tool.catalog.js';
import type { BuiltinTool } from '../tools/tool.types.js';
import { ArtifactsService, isSafeFileName } from './artifacts.service.js';

export const CREATE_FILE = 'builtin.create_file';

const MIME = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
} as const;

const input = z.object({
  fileName: z
    .string()
    .min(1)
    .max(120)
    .regex(/\.(md|txt|csv|json)$/i, 'name.md · .txt · .csv · .json only')
    .refine(isSafeFileName, 'no folders or control characters')
    .describe('File name with extension (.md, .txt, .csv or .json), e.g. report-2026-03.md'),
  content: z.string().min(1).max(200_000).describe('Full file content (UTF-8 text)'),
});

/**
 * 산출물 만들기 — 작업 결과를 내려받을 수 있는 텍스트 파일(리포트 · 표 · 데이터)로 남긴다 (W-04 산출물).
 * 파일은 요청한 사용자의 작업에만 붙고 외부로 나가지 않으므로 읽기 등급(승인 없음)으로 둔다.
 */
export function createFileTool(artifacts: ArtifactsService): BuiltinTool<z.infer<typeof input>> {
  return {
    name: CREATE_FILE,
    description:
      'Save a downloadable file for the user (report, table, data). Use it when the user asks for a file, report or export; mention the file in the answer.',
    level: 'read',
    idempotent: false,
    timeoutMs: 10_000,
    input,
    async execute(args, ctx) {
      const ext = args.fileName.split('.').pop()!.toLowerCase() as keyof typeof MIME;
      const file = await artifacts.createOutput({
        tenantId: ctx.tenantId,
        taskId: ctx.taskId,
        endUserId: ctx.endUserId,
        fileName: args.fileName,
        mimeType: MIME[ext],
        data: Buffer.from(args.content, 'utf8'),
      });
      return {
        saved: true,
        artifactId: file.id,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
      };
    },
  };
}

/** API · Worker 양쪽 카탈로그에 같은 시점에 등록해야 builtinsHash 가 같아진다 */
@Injectable()
export class ArtifactToolsRegistrar implements OnModuleInit {
  constructor(
    private readonly catalog: BuiltinToolCatalog,
    private readonly artifacts: ArtifactsService,
  ) {}

  onModuleInit(): void {
    this.catalog.register(createFileTool(this.artifacts) as BuiltinTool);
  }
}
