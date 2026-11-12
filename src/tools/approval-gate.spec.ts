import { nextStatus } from '../approvals/approvals.service.js';
import { taskScopeAllowed } from '../tasks/approval-views.js';
import { argsHash, riskLevel, summarize } from './approval-gate.service.js';

describe('승인 게이트 도우미', () => {
  it('인자 해시는 키 순서와 무관하고, 값이 바뀌면 달라진다', () => {
    expect(argsHash({ to: 'a@x.com', text: '안녕', meta: { b: 1, a: [1, 2] } })).toBe(
      argsHash({ meta: { a: [1, 2], b: 1 }, text: '안녕', to: 'a@x.com' }),
    );
    expect(argsHash({ to: 'a@x.com' })).not.toBe(argsHash({ to: 'b@x.com' }));
    expect(argsHash({ a: [1, 2] })).not.toBe(argsHash({ a: [2, 1] }));
    expect(argsHash({ a: 1, b: undefined })).toBe(argsHash({ a: 1 }));
  });

  it('위험도 — 등급 기준, 조건 규칙에 걸리면 high', () => {
    expect(riskLevel('read', false)).toBe('low');
    expect(riskLevel('write', false)).toBe('medium');
    expect(riskLevel('external_send', false)).toBe('medium');
    expect(riskLevel('delete', false)).toBe('high');
    expect(riskLevel('financial', false)).toBe('high');
    expect(riskLevel('write', true)).toBe('high');
  });

  it('카드 요약은 Tool 설명의 첫 문장', () => {
    expect(summarize({ name: 'a.b', description: '파일을 올린다. 공유도 한다.' })).toBe(
      '파일을 올린다.',
    );
    expect(summarize({ name: 'drive.upload', description: '' })).toBe('drive.upload');
  });
});

describe('승인 결정 상태 (nextStatus)', () => {
  const base = { userDecision: null, operatorDecision: null } as const;

  it('거절은 누구든 바로 rejected', () => {
    expect(nextStatus({ ...base, requiredApprover: 'user_and_operator' }, 'user', 'reject')).toBe(
      'rejected',
    );
  });

  it('user · operator 승인은 한 번이면 approved (운영자는 사용자 대신 승인 가능)', () => {
    expect(nextStatus({ ...base, requiredApprover: 'user' }, 'user', 'approve')).toBe('approved');
    expect(nextStatus({ ...base, requiredApprover: 'user' }, 'operator', 'approve')).toBe(
      'approved',
    );
    expect(nextStatus({ ...base, requiredApprover: 'operator' }, 'operator', 'approve')).toBe(
      'approved',
    );
  });

  it('user_and_operator 는 양쪽 모두 승인해야 approved (순서 무관)', () => {
    expect(nextStatus({ ...base, requiredApprover: 'user_and_operator' }, 'user', 'approve')).toBe(
      'pending',
    );
    expect(
      nextStatus(
        { requiredApprover: 'user_and_operator', userDecision: 'approve', operatorDecision: null },
        'operator',
        'approve',
      ),
    ).toBe('approved');
    expect(
      nextStatus(
        { requiredApprover: 'user_and_operator', userDecision: null, operatorDecision: 'approve' },
        'user',
        'approve',
      ),
    ).toBe('approved');
  });
});

describe('taskScopeAllowed', () => {
  it('정책이 허용하고, 매번 묻는 등급 · 방식이 아니며, 규칙 때문에 생긴 승인이 아닐 때만', () => {
    const write = { permissionLevel: 'write' as const, matchedRuleIds: [] };
    expect(taskScopeAllowed(write, { allowTaskScope: true, mode: 'require_approval' })).toBe(true);
    expect(taskScopeAllowed(write, { allowTaskScope: false, mode: 'require_approval' })).toBe(
      false,
    );
    expect(taskScopeAllowed(write, { allowTaskScope: true, mode: 'always_approval' })).toBe(false);
    expect(taskScopeAllowed(write, null)).toBe(false);
    expect(
      taskScopeAllowed(
        { permissionLevel: 'financial', matchedRuleIds: [] },
        { allowTaskScope: true, mode: 'require_approval' },
      ),
    ).toBe(false);
    expect(
      taskScopeAllowed(
        { permissionLevel: 'write', matchedRuleIds: ['r1'] },
        { allowTaskScope: true, mode: 'require_approval' },
      ),
    ).toBe(false);
  });
});
