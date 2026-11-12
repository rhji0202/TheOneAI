import { z } from 'zod';

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'waiting_approval',
  'cancelled',
]);

/** docs/api-spec.md §0 PlanStep — 위젯 실행 계획 카드 한 줄 */
export const planStepSchema = z.object({
  index: z.number().int().min(1),
  title: z.string(),
  kind: z.enum(['tool', 'skill', 'respond']),
  toolName: z.string().optional(),
  skill: z.object({ name: z.string(), version: z.string() }).optional(),
  requiresApproval: z.boolean(),
  status: stepStatusSchema,
});
export type PlanStep = z.infer<typeof planStepSchema>;

/** tasks.plan 컬럼 */
export const storedPlanSchema = z.object({
  version: z.number().int().min(1),
  steps: z.array(planStepSchema),
  revisedReason: z.string().nullable(),
});
export type StoredPlan = z.infer<typeof storedPlanSchema>;

export function parseStoredPlan(value: unknown): StoredPlan | null {
  const parsed = storedPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
