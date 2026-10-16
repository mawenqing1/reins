#!/usr/bin/env node
/* ============================================================
   Reins — LESS 编译脚本
   node tools/build-css.js          编译 src/*.less → web/assets/*.css
   node tools/build-css.js --watch  编译并监听 src/ 变更
   ============================================================ */
const fs = require('fs');
const path = require('path');
const less = require('less');

const root = path.join(__dirname, '..');
const pairs = [
  ['src/app.less', 'web/assets/app.css'],
  ['src/landing.less', 'web/assets/landing.css'],
];

async function build() {
  for (const [src, out] of pairs) {
    const source = fs.readFileSync(path.join(root, src), 'utf8');
    const result = await less.render(source, {
      filename: path.join(root, src),   // 供 @import 相对解析与报错定位
      sourceMap: { sourceMapFileInline: true },
    });
    fs.writeFileSync(path.join(root, out), result.css);
    console.log(`  ✓ ${src} → ${out} (${(result.css.length / 1024).toFixed(1)} kB)`);
  }
}

build()
  .then(() => { if (!process.argv.includes('--watch')) console.log('完成。'); })
  .catch(e => { console.error(e.message || e); process.exit(1); });

if (process.argv.includes('--watch')) {
  let timer = null;
  fs.watch(path.join(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch(e => console.error(e.message || e)), 150);
  });
  console.log('… 正在监听 src/ 变更（Ctrl+C 退出）');
}
