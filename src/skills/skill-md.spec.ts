import { parseSkillMd, SkillParseError } from './skill-md.js';

const valid = `---
name: report-writer
description: 매출 데이터를 조회해 월간 리포트를 작성합니다. 리포트 요청에 사용.
allowed-tools: builtin.calculate, shop.*
version: 1.3.0
title: 월간 리포트
example_prompt: 3월 매출 리포트 만들어줘
---
# 리포트 작성 절차
1. 기간을 확인한다.
2. 수치를 계산한다.
`;

function issues(text: string) {
  try {
    parseSkillMd(text);
  } catch (err) {
    if (err instanceof SkillParseError) return err.issues;
    throw err;
  }
  throw new Error('파싱 오류가 나야 합니다');
}

describe('parseSkillMd', () => {
  it('frontmatter · 본문 · 허용 Tool · 버전', () => {
    const skill = parseSkillMd(valid);
    expect(skill).toMatchObject({
      name: 'report-writer',
      allowedTools: ['builtin.calculate', 'shop.*'],
      version: '1.3.0',
      title: '월간 리포트',
      examplePrompt: '3월 매출 리포트 만들어줘',
      bodyStartLine: 9,
      warnings: [],
    });
    expect(skill.body.startsWith('# 리포트 작성 절차')).toBe(true);
  });

  it('CRLF · BOM · 배열 allowed-tools · metadata.version', () => {
    const text =
      '\uFEFF---\r\nname: a-b\r\ndescription: d\r\nallowed-tools: [x.y, x.z]\r\nmetadata:\r\n  version: 2.0.1\r\n---\r\nbody\r\n';
    expect(parseSkillMd(text)).toMatchObject({ allowedTools: ['x.y', 'x.z'], version: '2.0.1' });
  });

  it('frontmatter 가 없거나 닫히지 않으면 1번째 줄 오류', () => {
    expect(issues('# no frontmatter')).toEqual([expect.objectContaining({ line: 1 })]);
    expect(issues('---\nname: a\n')).toEqual([
      expect.objectContaining({ line: 1, message: expect.stringContaining('닫는') }),
    ]);
  });

  it('필드 오류는 해당 줄 번호와 함께 모두 알려 준다', () => {
    const list = issues(`---
name: Report_Writer
description: ""
allowed-tools: 3
version: one
---
body`);
    expect(list.map((i) => i.line)).toEqual([2, 3, 4, 5]);
    expect(list[0]!.message).toContain('소문자');
  });

  it('YAML 문법 오류 · 중복 키 · __proto__', () => {
    expect(issues('---\nname: a\n  bad: [\n---\nbody')[0]!.message).toContain('YAML');
    expect(issues('---\nname: a\nname: b\ndescription: d\n---\nbody')[0]!.message).toContain(
      'YAML',
    );
    expect(
      issues('---\nname: a\ndescription: d\n__proto__: { polluted: true }\n---\nbody')[0]!.message,
    ).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('본문이 없으면 오류, 길면 경고, 모르는 키는 경고', () => {
    expect(issues('---\nname: a\ndescription: d\n---\n\n')[0]).toMatchObject({ line: 5 });
    const long = parseSkillMd(
      `---\nname: a\ndescription: d\ncustom: 1\n---\n${'line\n'.repeat(600)}`,
    );
    expect(long.warnings).toHaveLength(2);
  });
});
