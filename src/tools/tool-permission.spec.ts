import type { ToolPolicy, ToolPolicyRule } from '../generated/prisma/client.js';
import { PolicySet } from './tool-permission.service.js';

const policy = (p: Partial<ToolPolicy> & Pick<ToolPolicy, 'level' | 'mode'>): ToolPolicy => ({
  id: `pol-${p.level}`,
  tenantId: 't',
  approver: null,
  allowTaskScope: false,
  ttlSeconds: 900,
  updatedById: null,
  updatedAt: new Date(),
  ...p,
});

const rule = (
  r: Partial<ToolPolicyRule> & Pick<ToolPolicyRule, 'id' | 'effect' | 'condition'>,
): ToolPolicyRule => ({
  tenantId: 't',
  name: r.id,
  description: null,
  toolPattern: null,
  level: null,
  priority: 100,
  enabled: true,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...r,
});

const levels = new Map([
  ['read', policy({ level: 'read', mode: 'auto' })],
  ['write', policy({ level: 'write', mode: 'require_approval', approver: 'user' })],
  ['delete', policy({ level: 'delete', mode: 'always_approval', approver: 'user_and_operator' })],
] as const);

const calc = { name: 'builtin.calculate', level: 'read' as const, modeOverride: null };
const upload = { name: 'drive.upload_file', level: 'write' as const, modeOverride: null };

describe('PolicySet', () => {
  it('등급 기본 정책: 읽기는 허용, 쓰기는 사용자 승인', () => {
    const set = new PolicySet(new Map(levels), []);
    expect(set.decide(calc, {})).toMatchObject({ decision: 'allow' });
    expect(set.decide(upload, {})).toMatchObject({
      decision: 'require_approval',
      approver: 'user',
    });
    expect(set.planningMode(upload)).toBe('approval');
  });

  it('정책이 없는 등급은 기본값 (financial → 항상 승인)', () => {
    const set = new PolicySet(new Map(), []);
    expect(
      set.decide({ name: 'pay.refund', level: 'financial', modeOverride: null }, {}),
    ).toMatchObject({
      decision: 'require_approval',
      approver: 'user_and_operator',
    });
  });

  it('Tool 재정의가 등급 정책보다 우선한다', () => {
    const set = new PolicySet(new Map(levels), []);
    expect(set.decide({ ...calc, modeOverride: 'block' }, {})).toMatchObject({
      decision: 'deny',
      deniedReason: 'blocked_by_policy',
    });
    expect(set.planningMode({ ...calc, modeOverride: 'block' })).toBe('blocked');
  });

  it('block 규칙은 인자 조건이 맞을 때만 차단한다', () => {
    const set = new PolicySet(new Map(levels), [
      rule({
        id: 'r1',
        toolPattern: 'builtin.*',
        effect: 'block',
        condition: { arg: 'expression', op: 'contains', value: '666' },
      }),
    ]);
    expect(set.decide(calc, { expression: '1+1' })).toMatchObject({ decision: 'allow' });
    expect(set.decide(calc, { expression: '666*2' })).toMatchObject({
      decision: 'deny',
      deniedReason: 'blocked_by_rule',
      matchedRuleIds: ['r1'],
    });
  });

  it('require_operator 규칙은 승인 주체를 강화한다 (완화는 없다)', () => {
    const set = new PolicySet(new Map(levels), [
      rule({
        id: 'big',
        level: 'write',
        effect: 'require_operator',
        condition: { arg: 'size', op: 'gt', value: 10 },
      }),
      rule({
        id: 'read-op',
        toolPattern: 'builtin.calculate',
        effect: 'require_operator',
        condition: { all: [] },
      }),
    ]);
    expect(set.decide(upload, { size: 50 })).toMatchObject({
      decision: 'require_approval',
      approver: 'user_and_operator',
    });
    expect(set.decide(upload, { size: 5 })).toMatchObject({
      decision: 'require_approval',
      approver: 'user',
    });
    // 자동 실행이던 읽기 Tool 도 운영자 승인이 필요해진다
    expect(set.decide(calc, {})).toMatchObject({
      decision: 'require_approval',
      approver: 'operator',
    });
  });

  it('다른 Tool · 등급에는 규칙이 적용되지 않는다', () => {
    const set = new PolicySet(new Map(levels), [
      rule({ id: 'r', toolPattern: 'drive.*', effect: 'block', condition: { all: [] } }),
    ]);
    expect(set.decide(calc, {})).toMatchObject({ decision: 'allow' });
    expect(set.decide(upload, {})).toMatchObject({ decision: 'deny' });
  });
});
