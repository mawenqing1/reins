/* ============================================================
   Reins — 状态持久化（userData/reins-data.json）
   原子写：先写临时文件再改名，避免掉电/崩溃损坏
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'reins-data.json');
let writeTimer = null;
let pending = null;

function loadState() {
  try {
    const raw = fs.readFileSync(FILE(), 'utf-8');
    const data = JSON.parse(raw);
    // 兼容三种结构：v1（顶层 tasks）/ v2（顶层 spaces）/ v3（orgs 组织层）；渲染层负责迁移与体检
    const ok = data && (
      (Array.isArray(data.agents) && (Array.isArray(data.tasks) || (Array.isArray(data.spaces) && data.spaces.length)))
      || (Array.isArray(data.orgs) && data.orgs.length)
    );
    if (ok) return data;
  } catch (e) { }
  return null;
}

function saveState(data, immediate = false) {
  pending = data;
  clearTimeout(writeTimer);
  const write = () => {
    writeTimer = null;
    try {
      const file = FILE();
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(pending));
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[store] save failed:', e.message); }
  };
  if (immediate) write();
  else writeTimer = setTimeout(write, 300); // 高频变更去抖
}
/* 退出前强制落盘：把去抖窗口内最后一次变更写透，避免关窗即丢 */
function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (pending) {
    try {
      const file = FILE();
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(pending));
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[store] flush failed:', e.message); }
  }
}

module.exports = { loadState, saveState, flush };
