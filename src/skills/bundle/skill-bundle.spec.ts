import yazl from 'yazl';
import { BundleError, bundleHash, normalize, readSkillZip } from './skill-bundle.js';

export async function makeZip(
  entries: Array<{ path: string; data: string | Buffer; mode?: number }>,
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const e of entries) {
    zip.addBuffer(
      Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data),
      e.path,
      e.mode ? { mode: e.mode } : {},
    );
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const SKILL = '---\nname: a\ndescription: d\n---\nbody\n';

describe('readSkillZip', () => {
  it('루트 SKILL.md · 파일 종류 · 숨김 파일 제외', async () => {
    const files = await readSkillZip(
      await makeZip([
        { path: 'SKILL.md', data: SKILL },
        { path: 'references/guide.md', data: '# guide' },
        { path: 'templates/report.md', data: '{{title}}' },
        { path: 'scripts/build.py', data: 'print(1)' },
        { path: 'assets/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) },
        { path: '.git/config', data: 'x' },
        { path: '__MACOSX/._SKILL.md', data: 'x' },
      ]),
    );
    expect(files.map((f) => [f.path, f.kind])).toEqual([
      ['SKILL.md', 'skill'],
      ['assets/logo.png', 'asset'],
      ['references/guide.md', 'doc'],
      ['scripts/build.py', 'script'],
      ['templates/report.md', 'template'],
    ]);
    expect(files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('최상위 폴더 하나로 감싼 zip 은 그 폴더를 루트로 본다', async () => {
    const files = await readSkillZip(
      await makeZip([
        { path: 'report-writer/SKILL.md', data: SKILL },
        { path: 'report-writer/references/a.md', data: 'a' },
      ]),
    );
    expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'references/a.md']);
  });

  it('SKILL.md 없음 · 심볼릭 링크 · zip 이 아님 → BundleError', async () => {
    await expect(readSkillZip(await makeZip([{ path: 'README.md', data: 'x' }]))).rejects.toThrow(
      BundleError,
    );
    await expect(
      readSkillZip(
        await makeZip([
          { path: 'SKILL.md', data: SKILL },
          { path: 'link', data: '/etc/passwd', mode: 0o120777 },
        ]),
      ),
    ).rejects.toThrow('심볼릭 링크');
    await expect(readSkillZip(Buffer.from('not a zip'))).rejects.toThrow(BundleError);
  });

  it('압축 해제 크기 · 파일 수 상한', async () => {
    const big = Buffer.alloc(17 * 1024 * 1024, 0x41); // 잘 압축되는 17MB (zip bomb 유형)
    await expect(
      readSkillZip(
        await makeZip([
          { path: 'SKILL.md', data: SKILL },
          { path: 'big.txt', data: big },
        ]),
      ),
    ).rejects.toThrow('16MB');
    const many = Array.from({ length: 513 }, (_, i) => ({ path: `f/${i}.txt`, data: 'x' }));
    await expect(
      readSkillZip(await makeZip([{ path: 'SKILL.md', data: SKILL }, ...many])),
    ).rejects.toThrow('512');
  });
});

describe('normalize · bundleHash', () => {
  it('경로 탈출 · 중복 경로는 거부', () => {
    const skill = { path: 'SKILL.md', data: Buffer.from(SKILL) };
    expect(() =>
      normalize([skill, { path: 'a/../../etc/passwd', data: Buffer.from('x') }]),
    ).toThrow(BundleError);
    expect(() => normalize([skill, { path: 'x/./y', data: Buffer.from('x') }])).toThrow(
      BundleError,
    );
    expect(() => normalize([skill, skill])).toThrow('두 번');
  });

  it('번들 해시는 파일 순서와 무관하고 내용 · 경로 변경에 반응한다', () => {
    const a = normalize([
      { path: 'SKILL.md', data: Buffer.from(SKILL) },
      { path: 'b.md', data: Buffer.from('b') },
    ]);
    const reversed = [...a].reverse();
    expect(bundleHash(a)).toBe(bundleHash(reversed));
    const changed = normalize([
      { path: 'SKILL.md', data: Buffer.from(SKILL) },
      { path: 'b.md', data: Buffer.from('B') },
    ]);
    expect(bundleHash(changed)).not.toBe(bundleHash(a));
  });
});
