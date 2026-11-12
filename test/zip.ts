import yazl from 'yazl';

/** 테스트용 zip 만들기 (Skill 번들) */
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
