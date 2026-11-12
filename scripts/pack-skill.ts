/**
 * 개발용: Skill 폴더를 업로드용 zip 으로 묶는다.
 *   npm run dev:pack-skill -- examples/skills/refund-helper [출력.zip]
 * 업로드: curl -F file=@refund-helper.zip -H "Authorization: Bearer $A" localhost:3000/v1/admin/skills
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import yazl from 'yazl';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('사용법: npm run dev:pack-skill -- <skill 폴더> [출력.zip]');
  process.exit(1);
}
const dir = resolve(dirArg);
const out = resolve(outArg ?? `${basename(dir)}.zip`);

function files(current: string): string[] {
  return readdirSync(current).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const path = join(current, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const zip = new yazl.ZipFile();
const list = files(dir);
for (const file of list)
  zip.addBuffer(readFileSync(file), relative(dir, file).split('\\').join('/'));
zip.end();
const chunks: Buffer[] = [];
for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
writeFileSync(out, Buffer.concat(chunks));
console.log(`${out} (${list.length}개 파일)`);
