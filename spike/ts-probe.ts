/**
 * 探针：Electron 44（内嵌 Node 24）能否直接以 .ts 作为应用入口（Node 类型剥离）。
 * 用法：node scripts/launch.mjs spike/ts-probe.ts
 */
import { app } from 'electron';
import { writeFileSync } from 'node:fs';

const typeCheck: number = 42; // 若类型剥离生效，这行不应让运行期报错

writeFileSync(
  new URL('./ts-probe-result.txt', import.meta.url),
  `ok typeCheck=${typeCheck} electron=${process.versions.electron} node=${process.versions.node}\n`,
);

app.whenReady().then(() => {
  writeFileSync(
    new URL('./ts-probe-result.txt', import.meta.url),
    `ok typeCheck=${typeCheck} electron=${process.versions.electron} node=${process.versions.node} ready=1\n`,
  );
  app.exit(0);
});
