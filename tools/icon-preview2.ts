/* 图标设计预览 v2：三个有品牌概念的方向（不做部署） */
import { app, BrowserWindow } from 'electron';
import fs = require('fs');
import path = require('path');
const OUT = '/tmp/icon-preview2';
fs.mkdirSync(OUT, { recursive: true });

const defs = `<defs>
  <linearGradient id="teal" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0F9184"/><stop offset="1" stop-color="#0A5C54"/>
  </linearGradient>
</defs>`;
const sq = `<rect x="0" y="0" width="100" height="100" rx="22.5" fill="url(#teal)" />`;

// D「衔」：马勒衔铁——口衔杆 + 缰环 + 左缰上扬（品牌的字面意象，极简几何化）
const D = `${defs}${sq}<g fill="none" stroke="#fff" stroke-linecap="round">
  <path d="M22 52 H57" stroke-width="12" />
  <circle cx="70" cy="52" r="11.5" stroke-width="10.5" />
  <path d="M22 52 C22 36 32 28 44 29" stroke-width="11" />
</g>`;

// E「缰」：一笔缰绳——收紧的环扣与甩出的绳尾，一个动作讲完 Reins
const E = `${defs}${sq}<path d="M63 22 C41 22 28 36 28 53 C28 69 40 78 52 78 C64 78 73 69 73 56 V38"
  fill="none" stroke="#fff" stroke-width="11.5" stroke-linecap="round" />`;

// F「R·缰」：几何 R 的腿末端系一只缰环——字母与品牌故事合体
const F = `${defs}${sq}<g fill="none" stroke="#fff" stroke-width="12.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M30 22 V78" />
  <path d="M30 22 H49 A13.5 13.5 0 0 1 49 49 H30" />
  <path d="M48 49 L61 62" />
</g>
<circle cx="69" cy="70" r="9.5" fill="none" stroke="#fff" stroke-width="9.5" />`;

const meta = {
  d: ['D · 衔', '马勒衔铁：口衔杆 + 缰环 + 上扬的左缰'],
  e: ['E · 缰', '一笔缰绳：收紧的环扣，甩出的绳尾'],
  f: ['F · R 缰', '几何 R 的腿端系着缰环（字母 × 故事）'],
};
const keys = ['d', 'e', 'f'];

const page = `<!doctype html><body style="margin:0">
  <div style="width:1560px;height:940px;background:linear-gradient(160deg,#22262B 0%,#3A4149 55%,#565F52 100%);font-family:-apple-system,'PingFang SC',sans-serif;padding:56px;box-sizing:border-box">
    <div style="color:#E8EAED;font-size:26px;font-weight:700;letter-spacing:1px">应用图标 v2 · 三个品牌化方向</div>
    <div style="color:#9AA0A7;font-size:15px;margin-top:8px">图形即故事：缰绳 / 衔铁 / R 与缰环 —— 统一品牌青渐变底 + 纯白圆头笔画</div>
    <div style="display:flex;gap:56px;margin-top:52px">
      ${keys.map(k => `
        <div style="text-align:center">
          <div style="width:340px;height:340px;border-radius:77px;overflow:hidden;box-shadow:0 18px 44px rgba(0,0,0,.38)">
            <svg viewBox="0 0 100 100" width="340" height="340">${{ d: D, e: E, f: F }[k]}</svg>
          </div>
          <div style="color:#E8EAED;font-size:17px;font-weight:600;margin-top:20px">${meta[k][0]}</div>
          <div style="color:#9AA0A7;font-size:13.5px;margin-top:6px">${meta[k][1]}</div>
        </div>`).join('')}
    </div>
    <div style="display:flex;align-items:flex-end;gap:16px;margin-top:76px;background:rgba(255,255,255,.16);border-radius:26px;padding:20px 26px;width:max-content;backdrop-filter:blur(6px)">
      ${keys.map(k => `<div style="width:92px;height:92px;border-radius:21px;overflow:hidden"><svg viewBox="0 0 100 100" width="92" height="92">${{ d: D, e: E, f: F }[k]}</svg></div>`).join('')}
      <div style="width:92px;height:92px;border-radius:50%;background:#1E9BF0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:40px;font-weight:700">S</div>
      <div style="width:92px;height:92px;border-radius:21px;background:#F4F5F4;display:flex;align-items:center;justify-content:center;font-size:46px">🚀</div>
    </div>
  </div>
</body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1560, height: 940, show: false, frame: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise(r => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'showcase2.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
});
