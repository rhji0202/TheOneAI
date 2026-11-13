import yazl from 'yazl';

/** 테스트용 문서 — 실제 Office · PDF 와 같은 구조라 실제 파서(extract_text.py · poppler)로 읽힌다 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function zipParts(parts: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, xml] of Object.entries(parts)) {
    zip.addBuffer(Buffer.from(XML_HEAD + xml), path);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const relsXml = (rels: Array<{ id: string; type: string; target: string }>) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${r.type}" Target="${r.target}"/>`,
    )
    .join('')}</Relationships>`;

type Cell = string | number | { date: string };

/** 시트마다 행 배열 — 문자열은 인라인 문자열, { date } 는 날짜 서식(yyyy-mm-dd) 숫자 셀 */
export function buildXlsx(
  sheets: Record<string, Cell[][]>,
  options: { hidden?: string[] } = {},
): Promise<Buffer> {
  const names = Object.keys(sheets);
  const col = (i: number) => String.fromCharCode(65 + i);
  const serial = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + 25_569;
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    '_rels/.rels': relsXml([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]),
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
      .map(
        (n, i) =>
          `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"${options.hidden?.includes(n) ? ' state="hidden"' : ''}/>`,
      )
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relsXml([
      ...names.map((_, i) => ({
        id: `rId${i + 1}`,
        type: 'worksheet',
        target: `worksheets/sheet${i + 1}.xml`,
      })),
      { id: `rId${names.length + 1}`, type: 'styles', target: 'styles.xml' },
    ]),
    'xl/styles.xml': `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  names.forEach((name, i) => {
    const rows = sheets[name]!.map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((v, c) => {
            const ref = `${col(c)}${r + 1}`;
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            if (typeof v === 'object') return `<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
          })
          .join('')}</row>`,
    );
    parts[`xl/worksheets/sheet${i + 1}.xml`] =
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  });
  return zipParts(parts);
}

/** 문단(문자열)과 표(행 · 셀 배열)를 차례로 */
export function buildDocx(blocks: Array<string | string[][]>): Promise<Buffer> {
  const para = (text: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const body = blocks
    .map((b) =>
      typeof b === 'string'
        ? para(b)
        : `<w:tbl>${b.map((row) => `<w:tr>${row.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`,
    )
    .join('');
  return zipParts({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': relsXml([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/** 슬라이드마다 문단 배열 — 파일 번호를 발표 순서와 반대로 매겨 순서를 presentation.xml 에서 읽는지 본다 */
export function buildPptx(slides: string[][]): Promise<Buffer> {
  const n = slides.length;
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    '_rels/.rels': relsXml([
      { id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' },
    ]),
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relsXml(
      slides.map((_, i) => ({
        id: `rId${i + 1}`,
        type: 'slide',
        target: `slides/slide${n - i}.xml`,
      })),
    ),
  };
  slides.forEach((lines, i) => {
    parts[`ppt/slides/slide${n - i}.xml`] =
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${lines
        .map((l) => `<a:p><a:r><a:t>${esc(l)}</a:t></a:r></a:p>`)
        .join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  });
  return zipParts(parts);
}

/** 페이지마다 글자(텍스트 레이어) 또는 도형만 있는 페이지(스캔본처럼 텍스트가 없다). 글자는 ASCII 만 */
export function buildPdf(pages: Array<{ text: string } | { shape: true }>): Buffer {
  const bodies: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const pageIds: number[] = [];
  pages.forEach((page, i) => {
    const pageId = 4 + i * 2;
    const stream =
      'text' in page
        ? `BT /F1 18 Tf 72 720 Td (${page.text.replace(/[()\\]/g, '\\$&')}) Tj ET`
        : '0.2 0.4 0.8 rg 72 420 360 260 re f';
    bodies[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    bodies[pageId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    pageIds.push(pageId);
  });
  bodies[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = bodies.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
