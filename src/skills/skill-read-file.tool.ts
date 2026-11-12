import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { BuiltinToolCatalog } from '../tools/builtin-tool.catalog.js';
import { ToolRegistryService } from '../tools/tool-registry.service.js';
import type { BuiltinTool } from '../tools/tool.types.js';
import { SkillRuntimeService } from './skill-runtime.service.js';

export const SKILL_READ_FILE = 'skill.read_file';

const input = z.object({
  skill: z.string().min(1).max(64).describe('Skill name'),
  path: z
    .string()
    .min(1)
    .max(255)
    .describe('File path inside the skill bundle, e.g. references/guide.md'),
});

/**
 * Skill 번들 안 텍스트 파일 읽기 (참조 문서 · 템플릿 · 스크립트 원문) — Skill 단계에서만 모델에게 준다.
 * 작업이 고정한 Registry 의 Skill 버전만, Agent 허용 목록 · 활성 상태를 다시 확인하고 읽는다.
 */
export function createSkillReadFileTool(
  runtime: SkillRuntimeService,
  registry: ToolRegistryService,
): BuiltinTool<z.infer<typeof input>> {
  return {
    name: SKILL_READ_FILE,
    description:
      'Read a text file bundled with the current skill (reference docs, templates, script sources).',
    level: 'read',
    // 실패(없는 파일 · 비활성 Skill)는 다시 시도해도 같다
    idempotent: false,
    timeoutMs: 10_000,
    input,
    async execute(args, ctx) {
      const snapshot = await registry.loadSnapshot(ctx.tenantId, ctx.registryVersionId);
      const pinned = snapshot.skills.find((s) => s.name === args.skill);
      const [available] = pinned
        ? await runtime.available(ctx.tenantId, ctx.agentVersionId, [pinned])
        : [];
      if (!available) throw new Error(`Skill '${args.skill}' is not available to this agent`);
      const loaded = await runtime.load(ctx.tenantId, available);
      return runtime.readFile(ctx.tenantId, loaded, args.path);
    },
  };
}

/** API · Worker 양쪽 카탈로그에 같은 시점에 등록해야 builtinsHash 가 같아진다 */
@Injectable()
export class SkillToolsRegistrar implements OnModuleInit {
  constructor(
    private readonly catalog: BuiltinToolCatalog,
    private readonly runtime: SkillRuntimeService,
    private readonly registry: ToolRegistryService,
  ) {}

  onModuleInit(): void {
    this.catalog.register(createSkillReadFileTool(this.runtime, this.registry) as BuiltinTool);
  }
}
