/* 图标设计预览：Electron 透明窗渲染 SVG → PNG（不做任何部署，仅供用户审阅） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = '/tmp/icon-preview';
fs.mkdirSync(OUT, { recursive: true });

// 几何 R 主形（100×100 网格，圆头粗笔画）：竖干 + 半圆碗 + 斜腿（腿与碗留断口，呼应托盘主形的动势）
const R = (c, sw = 13) => `
  <g fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M31 24 V76" />
    <path d="M31 24 H50 A13.5 13.5 0 0 1 50 51 H31" />
    <path d="M52 51 L71 76" />
  </g>`;

const squircle = (fill) =>
  `<rect x="0" y="0" width="100" height="100" rx="22.5" fill="${fill}" />`;

const defs = `<defs>
  <linearGradient id="teal" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0F9184"/><stop offset="1" stop-color="#0A5C54"/>
  </linearGradient>
  <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2A2F36"/><stop offset="1" stop-color="#171B20"/>
  </linearGradient>
  <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FDFDFC"/><stop offset="1" stop-color="#EFF1F0"/>
  </linearGradient>
</defs>`;

const variants = {
  a: `${defs}${squircle('url(#teal)')}${R('#FFFFFF')}`,
  b: `${defs}${squircle('url(#paper)')}${R('#0E7A70')}`,
  c: `${defs}${squircle('url(#ink)')}${R('#7FE0D4')}`,
};

// 合成预览：三枚大图 + 浅色 dock 条场景
const page = `<!doctype html><body style="margin:0">
  <div style="width:1560px;height:920px;background:linear-gradient(160deg,#22262B 0%,#3A4149 55%,#565F52 100%);font-family:-apple-system,'PingFang SC',sans-serif;padding:56px;box-sizing:border-box">
    <div style="color:#E8EAED;font-size:26px;font-weight:700;letter-spacing:1px">应用图标重设计 · 三个方向</div>
    <div style="color:#9AA0A7;font-size:15px;margin-top:8px">几何 R 主形 · 圆头粗笔画 · 扁平微渐变 · 未部署，仅供审阅</div>
    <div style="display:flex;gap:56px;margin-top:56px">
      ${['a', 'b', 'c'].map(k => `
        <div style="text-align:center">
          <div style="width:340px;height:340px;border-radius:77px;overflow:hidden;box-shadow:0 18px 44px rgba(0,0,0,.38)">
            <svg viewBox="0 0 100 100" width="340" height="340">${variants[k]}</svg>
          </div>
          <div style="color:#E8EAED;font-size:17px;font-weight:600;margin-top:20px">${{ a: 'A · 品牌青 / 白字（推荐）', b: 'B · 暖白底 / 青字', c: 'C · 石墨深底 / 浅青字' }[k]}</div>
        </div>`).join('')}
    </div>
    <div style="display:flex;align-items:flex-end;gap:16px;margin-top:88px;background:rgba(255,255,255,.16);border-radius:26px;padding:20px 26px;width:max-content;backdrop-filter:blur(6px)">
      ${['a', 'b', 'c'].map(k => `<div style="width:92px;height:92px;border-radius:21px;overflow:hidden"><svg viewBox="0 0 100 100" width="92" height="92">${variants[k]}</svg></div>`).join('')}
      <div style="width:92px;height:92px;border-radius:50%;background:#1E9BF0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:40px;font-weight:700">S</div>
      <div style="width:92px;height:92px;border-radius:21px;background:#F4F5F4;display:flex;align-items:center;justify-content:center;font-size:46px">🚀</div>
      <div style="width:92px;height:92px;border-radius:50%;background:linear-gradient(#FFD24C,#F5A623);display:flex;align-items:center;justify-content:center;font-size:42px">🛰</div>
    </div>
  </div>
</body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1560, height: 920, show: false, frame: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise(r => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'showcase.png'), img.toPNG());
  // 单枚母版（A 方案 512，供细看笔画）
  const w2 = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false });
  await w2.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<body style="margin:0"><svg viewBox="0 0 100 100" width="512" height="512">${variants.a}</svg></body>`));
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(path.join(OUT, 'variant-a.png'), (await w2.webContents.capturePage()).toPNG());
  app.quit();
});
