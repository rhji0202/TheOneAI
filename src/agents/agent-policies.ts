import { z } from 'zod';

/** agent_versions.execution_policy — docs/data-model.md §4.1 */
export const executionPolicySchema = z.object({
  /** Tool 호출도 한 단계로 센다 */
  maxSteps: z.number().int().min(1).max(200).default(40),
  maxDurationSec: z.number().int().min(10).max(86_400).default(1_800),
  tokenBudget: z.number().int().min(1_000).default(200_000),
  toolRetry: z
    .object({
      maxAttempts: z.number().int().min(1).max(5).default(2),
      backoff: z.literal('exponential').default('exponential'),
      baseMs: z.number().int().min(50).default(500),
    })
    .prefault({}),
  replanLimit: z.number().int().min(0).max(10).default(3),
  /** Reflection — 답변 검증에서 구체적인 오류가 나오면 한 번 바로잡는 후속 메시지를 보낸다 */
  selfCorrection: z.boolean().default(true),
  parallelTools: z
    .object({
      enabled: z.boolean().default(true),
      max: z.number().int().min(1).max(10).default(3),
    })
    .prefault({}),
  approvalTtlSec: z.number().int().min(60).max(86_400).optional(),
  sandbox: z
    .object({
      cpu: z.number().min(0.25).max(8).default(1),
      memoryMb: z.number().int().min(128).max(16_384).default(1_024),
      timeoutSec: z.number().int().min(1).max(600).default(30),
      network: z.enum(['none', 'allowlist']).default('none'),
    })
    .prefault({}),
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

/** agent_versions.memory_policy — docs/data-model.md §4.2 */
export const memoryPolicySchema = z.object({
  enabled: z.boolean().default(true),
  types: z
    .array(z.enum(['episodic', 'semantic', 'procedural']))
    .default(['episodic', 'semantic', 'procedural']),
  retentionDays: z.number().int().min(1).max(3_650).default(90),
  topK: z.number().int().min(0).max(50).default(5),
  /** 유사도와 상관없이 늘 넣는 사용자 프로필(user 범위 semantic) 개수 */
  profileSize: z.number().int().min(0).max(10).default(3),
  minConfidence: z.number().min(0).max(1).default(0.5),
});
export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;

export const defaultExecutionPolicy = (): ExecutionPolicy => executionPolicySchema.parse({});
export const defaultMemoryPolicy = (): MemoryPolicy => memoryPolicySchema.parse({});
