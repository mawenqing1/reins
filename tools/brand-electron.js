/* 开发态品牌名补丁：electron . 直接跑的是 node_modules 里的 Electron.app，
   Dock/菜单栏/⌘-Tab 显示名来自其 Info.plist（默认 "Electron"）。
   幂等写入 Reins 驭码 与自有 bundle id；npm start 自动执行，重装依赖后自动补上。 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');
const NAME = 'Reins 驭码';
const BID = 'dev.reins.desktop';

if (!fs.existsSync(APP)) { console.log('  · 未找到开发态 Electron.app，跳过品牌名补丁'); process.exit(0); }

const pb = (cmd) => spawnSync('/usr/libexec/PlistBuddy', ['-c', cmd, APP], { encoding: 'utf8' });
let touched = false;
for (const [key, val] of [['CFBundleName', NAME], ['CFBundleDisplayName', NAME], ['CFBundleIdentifier', BID]]) {
  const cur = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, APP], { encoding: 'utf8' });
  if (cur.status === 0 && cur.stdout.trim() === val) continue;
  if (pb(`Set :${key} ${val}`).status !== 0) pb(`Add :${key} string ${val}`);
  touched = true;
}
console.log(touched ? `  ✓ 开发态 Electron 品牌名已置为 ${NAME}` : '  · 品牌名已是 Reins 驭码，无需修改');
