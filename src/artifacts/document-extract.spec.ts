import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { buildDocx, buildPdf, buildPptx, buildXlsx } from '../../test/document-fixtures.js';
import {
  DocumentUnreadableError,
  documentKind,
  extractDocument,
  queryTable,
} from './document-extract.js';

const options = {
  python: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  popplerPath: process.env.POPPLER_PATH || null,
};
const pdftoppm = options.popplerPath ? join(options.popplerPath, 'pdftoppm') : 'pdftoppm';
const hasPoppler = spawnSync(pdftoppm, ['-v']).status === 0;

describe('documentKind', () => {
  it('형식으로, 모호하면 확장자로 판단한다', () => {
    expect(documentKind('application/pdf', 'a.bin')).toBe('pdf');
    expect(documentKind('application/octet-stream', '재고.XLSX')).toBe('xlsx');
    expect(documentKind('text/plain', 'a.txt')).toBeNull();
  });
});

describe('extractDocument', () => {
  it('XLSX — 보이는 시트마다 CSV (날짜는 YYYY-MM-DD, 쉼표 · 따옴표는 CSV 규칙대로)', async () => {
    const xlsx = await buildXlsx(
      {
        재고: [
          ['품목', '수량', '입고일'],
          ['볼트 M8', 1200, { date: '2026-11-12' }],
          ['너트, 육각', 340, { date: '2026-11-01' }],
        ],
        비밀: [['숨긴 시트']],
        메모: [['비고'], ['"긴급" 재주문']],
      },
      { hidden: ['비밀'] },
    );
    expect(await extractDocument('xlsx', xlsx, options)).toEqual({
      text: [
        'Sheet "재고" (3 rows)',
        '품목,수량,입고일',
        '볼트 M8,1200,2026-11-12',
        '"너트, 육각",340,2026-11-01',
        '',
        'Sheet "메모" (2 rows)',
        '비고',
        '"""긴급"" 재주문"',
      ].join('\n'),
      images: [],
    });
  });

  it('DOCX — 문단과 표', async () => {
    const docx = await buildDocx([
      '재고 보고서',
      [
        ['품목', '수량'],
        ['볼트', '1200'],
      ],
      '끝',
    ]);
    expect((await extractDocument('docx', docx, options)).text).toBe(
      '재고 보고서\n품목 | 수량\n볼트 | 1200\n\n끝',
    );
  });

  it('PPTX — 파일 번호가 아니라 발표 순서대로', async () => {
    const pptx = await buildPptx([['첫 슬라이드', '요약'], ['둘째 슬라이드']]);
    expect((await extractDocument('pptx', pptx, options)).text).toBe(
      'Slide 1\n첫 슬라이드\n요약\n\nSlide 2\n둘째 슬라이드',
    );
  });

  it.skipIf(!hasPoppler)(
    'PDF — 텍스트 페이지는 글자로, 텍스트가 없는 페이지는 PNG 로',
    async () => {
      const pdf = buildPdf([{ text: 'Invoice total 32500 KRW for order 1001' }, { shape: true }]);
      const doc = await extractDocument('pdf', pdf, options);
      expect(doc.text).toBe('--- Page 1 ---\nInvoice total 32500 KRW for order 1001');
      expect(doc.images).toHaveLength(1);
      expect(doc.images[0]).toMatchObject({ mimeType: 'image/png', page: 2 });
      expect(Buffer.from(doc.images[0]!.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    },
  );

  it('압축을 푼 크기가 상한을 넘는 파일은 열지 않는다', async () => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.alloc(60 * 1024 * 1024), 'xl/worksheets/sheet1.xml');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
    await expect(extractDocument('xlsx', Buffer.concat(chunks), options)).rejects.toThrow(
      /unpacked size is too large/,
    );
  });

  it('형식이 맞지 않으면 이유를 알려 준다', async () => {
    const err = await extractDocument('docx', Buffer.from('not a zip'), options).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DocumentUnreadableError);
    expect((err as Error).message).toMatch(/not a valid Office file/);
  });
});

describe('queryTable', () => {
  const stock = () =>
    buildXlsx({
      재고: [
        ['품목', '수량', '단가'],
        ['볼트', 1200, 30],
        ['너트', 340, 20],
        ['볼트', 100, 30],
      ],
    });

  it('시트를 테이블로 올려 SELECT 로 집계한다', async () => {
    const result = await queryTable(
      'xlsx',
      await stock(),
      'SELECT 품목, SUM(수량) AS 합계, SUM(수량 * 단가) AS 금액 FROM 재고 GROUP BY 품목 ORDER BY 합계 DESC',
      '',
      options,
    );
    expect(result).toEqual({
      tables: [{ name: '재고', columns: ['품목', '수량', '단가'], rows: 3 }],
      columns: ['품목', '합계', '금액'],
      rows: [
        ['볼트', 1300, 39000],
        ['너트', 340, 6800],
      ],
      truncated: false,
    });
  });

  it('CSV 는 파일 이름을 테이블로, 천 단위 쉼표 숫자도 숫자로', async () => {
    const csv = Buffer.from(['지역,매출', '서울,"1,200"', '부산,80', ''].join('\n'));
    const result = await queryTable('csv', csv, 'SELECT SUM(매출) FROM 매출표', '매출표', options);
    expect(result.rows).toEqual([[1280]]);
  });

  it('읽기 전용 — ATTACH · 쓰기는 거부하고, SQL 오류는 이유를 알려 준다', async () => {
    const xlsx = await stock();
    for (const sql of ["ATTACH DATABASE 'x.db' AS x", 'DELETE FROM 재고']) {
      await expect(queryTable('xlsx', xlsx, sql, '', options)).rejects.toThrow('not authorized');
    }
    await expect(queryTable('xlsx', xlsx, 'SELECT 없는열 FROM 재고', '', options)).rejects.toThrow(
      /no such column/,
    );
  });
});
