/**
 * 从注册表快照里打印指定插件的详细信息（含安装命令）。
 * 用法：node spike/registry-show.mjs <name> [name...]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../docs/m0-evidence/plugins.json', import.meta.url));
const j = JSON.parse(readFileSync(FILE, 'utf8'));
const want = process.argv.slice(2);

const hit = j.plugins.filter((x) => want.includes(x.name));
console.log(`matched ${hit.length}/${want.length} of ${j.plugins.length}`);

for (const p of hit) {
  const d = p.description || {};
  console.log('\n--- ' + p.name);
  console.log(
    JSON.stringify(
      {
        owner: p.owner,
        npm: p.npm,
        version: p.version,
        stars: p.stars,
        downloads: p.downloads,
        capabilities: p.capabilities,
        redLines: p.capabilityRedLines,
        install: p.install,
        added: p.added,
        url: p.url,
        page: p.page,
      },
      null,
      1,
    ),
  );
  console.log('  zh: ' + String(d.zh || '').slice(0, 220));
}
