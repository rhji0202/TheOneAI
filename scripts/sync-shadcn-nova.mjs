import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import ts from 'typescript';
import { format, resolveConfig } from 'prettier';

const root = resolve(import.meta.dirname, '..');
const cache = resolve(root, '.storage/shadcn-nova');
const apps = ['console', 'widget'];
const inventory = [];
for (const app of apps) {
  const config = JSON.parse(await readFile(resolve(root, `apps/${app}/components.json`), 'utf8'));
  if (config.style !== 'radix-nova') throw Error(`${app}: expected the radix-nova style`);
  const directory = resolve(root, `apps/${app}/src/components/ui`);
  for (const file of await readdir(directory)) {
    if (file.endsWith('.tsx'))
      inventory.push({ app, name: basename(file, '.tsx'), path: resolve(directory, file) });
  }
}
await mkdir(cache, { recursive: true });
const names = [...new Set(inventory.map(({ name }) => name))].sort();
const registry = {};
const refresh = process.argv.includes('--refresh');
for (let i = 0; i < names.length; i += 4) {
  await Promise.all(
    names.slice(i, i + 4).map(async (name) => {
      const url = `https://ui.shadcn.com/r/styles/radix-nova/${name}.json`;
      if (!refresh) {
        try {
          registry[name] = { url, source: await readFile(resolve(cache, `${name}.tsx`), 'utf8') };
          return;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const response = await fetch(url);
      if (!response.ok) throw Error(`${name}: registry returned ${response.status}`);
      const item = await response.json();
      const file = item.files.find((file) => file.path.endsWith(`/ui/${name}.tsx`));
      if (!file) throw Error(`${name}: no component source in registry`);
      let source = file.content;
      if (!source.includes('\n') && source.includes('\\n')) source = JSON.parse(`"${source}"`);
      source = source.replace(/from ["']cn["']/g, "from '@/lib/utils'");
      registry[name] = { url, dependencies: item.dependencies ?? [], source };
      await writeFile(resolve(cache, `${name}.tsx`), source);
    }),
  );
  if (refresh)
    console.log(`Fetched ${Math.min(i + 4, names.length)}/${names.length} Nova components`);
}
const report = [];
for (const item of inventory) {
  const local = await readFile(item.path, 'utf8');
  report.push({
    ...item,
    lines: local.split('\n').length,
    upstreamLines: registry[item.name].source.split('\n').length,
    dependencies: registry[item.name].dependencies,
  });
}
await writeFile(resolve(cache, 'inventory.json'), JSON.stringify(report, null, 2));
if (process.argv.includes('--inventory')) console.log(JSON.stringify(report, null, 2));

function parse(source) {
  return ts.createSourceFile(
    'component.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function functionSource(source, name) {
  const declaration = parse(source).statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw Error(`Missing ${name} function`);
  return declaration;
}

function adaptSource(source, app, name, local) {
  source = source
    .replaceAll('@/registry/radix-nova/ui/', '@/components/ui/')
    .replaceAll('@/registry/radix-nova/hooks/', '@/hooks/');
  const tree = parse(source);
  const replacements = [];
  const icons = new Set();
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'IconPlaceholder') {
      const attributes = node.attributes.properties;
      const icon = attributes.find(
        (attr) => ts.isJsxAttribute(attr) && attr.name.text === 'lucide',
      );
      if (!icon?.initializer || !ts.isStringLiteral(icon.initializer))
        throw Error(`${name}: missing Lucide icon`);
      icons.add(icon.initializer.text);
      const retained = attributes.filter(
        (attr) =>
          !ts.isJsxAttribute(attr) ||
          !['lucide', 'tabler', 'hugeicons', 'phosphor', 'remixicon'].includes(attr.name.text),
      );
      replacements.push({
        start: node.getStart(tree),
        end: node.end,
        text: `<${icon.initializer.text} ${retained.map((attr) => attr.getText(tree)).join(' ')} />`,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const edit of replacements.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  source = source.replace(/^import \{ IconPlaceholder \} from .*\r?\n/gm, '');
  if (icons.size)
    source = source.replace(
      /^import /m,
      `import { ${[...icons].sort().join(', ')} } from 'lucide-react';\nimport `,
    );
  source = source.replaceAll('>Close</span>', '>닫기</span>');
  source = source.replaceAll('Toggle Sidebar', '메뉴 접기 · 펼치기');

  if (app === 'console' && name === 'button') {
    const declaration = functionSource(source, 'Button');
    const preserved = functionSource(local, 'Button').getText();
    source = source.slice(0, declaration.getStart()) + preserved + source.slice(declaration.end);
    source = source.replace(/^import /m, "import { Loader2Icon } from 'lucide-react';\nimport ");
  }
  if (name === 'sidebar') {
    source = source.replace('  Tooltip,\n', '  Tooltip,\n  TooltipProvider,\n');
    source = source.replace(
      '<SidebarContext.Provider value={contextValue}>',
      '<SidebarContext.Provider value={contextValue}><TooltipProvider delayDuration={0}>',
    );
    source = source.replace(
      '</SidebarContext.Provider>',
      '</TooltipProvider></SidebarContext.Provider>',
    );
  }
  if (name === 'sonner') {
    source = source.replace('import { useTheme } from "next-themes"\n', '');
    source = source.replace('  const { theme = "system" } = useTheme()\n', '');
    source = source.replace('theme={theme as ToasterProps["theme"]}', 'theme="system"');
  }
  if (name === 'tabs') {
    source = source.replace(
      'after:absolute after:bg-foreground',
      'after:absolute after:hidden group-data-[variant=line]/tabs-list:after:block after:bg-foreground',
    );
    if (app === 'console')
      source = source.replace(
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring',
        'focus-visible:outline-none',
      );
  }
  return source;
}

if (process.argv.includes('--write') || process.argv.includes('--check')) {
  const appFilter = process.argv.find((arg) => arg.startsWith('--app='))?.slice(6);
  const prettierConfig = await resolveConfig(resolve(root, 'package.json'));
  const changed = [];
  for (const item of inventory.filter((item) => !appFilter || item.app === appFilter)) {
    const local = await readFile(item.path, 'utf8');
    const expected = await format(
      adaptSource(registry[item.name].source, item.app, item.name, local),
      { ...prettierConfig, filepath: item.path },
    );
    if (local.replaceAll('\r\n', '\n') !== expected.replaceAll('\r\n', '\n')) {
      changed.push(`${item.app}/${item.name}`);
      if (process.argv.includes('--write')) {
        const backup = resolve(cache, 'before', item.app);
        await mkdir(backup, { recursive: true });
        try {
          await writeFile(resolve(backup, `${item.name}.tsx`), local, { flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        await writeFile(item.path, expected);
      }
    }
  }
  console.log(
    `${process.argv.includes('--write') ? 'Updated' : 'Style differences'}: ${changed.length} components`,
    changed,
  );
  if (!appFilter || appFilter === 'console') {
    for (const file of await readdir(resolve(root, 'apps/console/src/pages'))) {
      if (!file.endsWith('.tsx')) continue;
      const path = resolve(root, 'apps/console/src/pages', file);
      const local = await readFile(path, 'utf8');
      if (!local.includes('containerClassName=')) continue;
      const tree = parse(local);
      const edits = [];
      function check(node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
          const container = attrs.find((attr) => attr.name.text === 'containerClassName');
          const classes = attrs.find((attr) => attr.name.text === 'className');
          if (container) {
            if (classes) {
              if (
                !container.initializer ||
                !classes.initializer ||
                !ts.isStringLiteral(container.initializer) ||
                !ts.isStringLiteral(classes.initializer)
              )
                throw Error(`${file}: expected literal NativeSelect layout classes`);
              edits.push({
                start: container.getStart(tree),
                end: container.end,
                text: `className=${JSON.stringify(`${container.initializer.text} ${classes.initializer.text}`)}`,
              });
              edits.push({ start: classes.getStart(tree), end: classes.end, text: '' });
            } else
              edits.push({
                start: container.name.getStart(tree),
                end: container.name.end,
                text: 'className',
              });
          }
        }
        ts.forEachChild(node, check);
      }
      check(tree);
      let migrated = local;
      for (const edit of edits.sort((a, b) => b.start - a.start))
        migrated = migrated.slice(0, edit.start) + edit.text + migrated.slice(edit.end);
      if (process.argv.includes('--write'))
        await writeFile(path, await format(migrated, { ...prettierConfig, filepath: path }));
      else {
        changed.push(`pages/${file}: NativeSelect API`);
        console.error(`NativeSelect caller needs migration: ${file}`);
      }
    }
  }
  if (process.argv.includes('--check') && changed.length) process.exitCode = 1;
}
