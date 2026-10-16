/* 图标设计预览 v3：AI 科技感方向（深色底 + 链路/脉冲/电路，不部署） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = '/tmp/icon-preview3';
fs.mkdirSync(OUT, { recursive: true });

// 深墨青科技底（近黑的青绿渐变）+ 微弱内光
const defs = `<defs>
  <linearGradient id="deep" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#14312B"/><stop offset="1" stop-color="#0A1613"/>
  </linearGradient>
  <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2DD4BF" stop-opacity=".9"/><stop offset="1" stop-color="#14A08F" stop-opacity=".55"/>
  </linearGradient>
  <filter id="blur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.2" /></filter>
</defs>`;
const sq = `<rect x="0" y="0" width="100" height="100" rx="22.5" fill="url(#deep)" />`;

// G「链路」：一条缰绳曲线串起三个 Agent 节点——终点是发光的主节点（编排调度）
const G = `${defs}${sq}
  <path d="M24 74 C30 50 44 66 52 48 C58 34 62 30 66 26" fill="none" stroke="#EAFBF8" stroke-width="7.5" stroke-linecap="round" opacity=".92" />
  <circle cx="24" cy="74" r="5" fill="#8FD8CE" />
  <circle cx="51" cy="50.5" r="5.5" fill="#B7E8E0" />
  <g><circle cx="68" cy="24" r="10.5" fill="url(#glow)" filter="url(#blur)" opacity=".9" /></g>
  <circle cx="68" cy="24" r="7.5" fill="#EAFBF8" />`;

// H「脉冲」：AI 四芒星 + 延伸成缰绳的尾迹（一撇拉出的信号轨迹）
const H = `${defs}${sq}
  <g><path d="M56 40 L62 52 L74 58 L62 64 L56 76 L50 64 L38 58 L50 52 Z" fill="#2DD4BF" filter="url(#blur)" opacity=".8" /></g>
  <path d="M56 40 L62 52 L74 58 L62 64 L56 76 L50 64 L38 58 L50 52 Z" fill="#EAFBF8" />
  <path d="M38 58 C30 58 26 62 22 70" fill="none" stroke="#8FD8CE" stroke-width="6" stroke-linecap="round" opacity=".9" />`;

// I「矩阵」：R 由电路走线构成——端点带节点焊点，字母即电路
const I = `${defs}${sq}<g fill="none" stroke="#EAFBF8" stroke-width="10.5" stroke-linecap="round">
    <path d="M32 26 V74" />
    <path d="M32 26 H48 A13 13 0 0 1 48 52 H32" />
    <path d="M47 52 L64 68" />
  </g>
  <circle cx="32" cy="20" r="5" fill="#2DD4BF" />
  <circle cx="70" cy="73" r="5" fill="#2DD4BF" />`;

const meta = {
  g: ['G · 链路', '缰绳曲线串起三个 Agent 节点，终点发光——编排调度'],
  h: ['H · 脉冲', 'AI 四芒星，一撇尾迹拉成缰绳——模型输出的轨迹'],
  i: ['I · 矩阵', 'R 由电路走线构成，端点是信号节点——字母即电路'],
};
const keys = ['g', 'h', 'i'];
const art = { g: G, h: H, i: I };

const page = `<!doctype html><body style="margin:0">
  <div style="width:1560px;height:940px;background:linear-gradient(160deg,#1B1F24 0%,#2E3540 55%,#3E4A44 100%);font-family:-apple-system,'PingFang SC',sans-serif;padding:56px;box-sizing:border-box">
    <div style="color:#E8EAED;font-size:26px;font-weight:700;letter-spacing:1px">应用图标 v3 · AI 科技感方向</div>
    <div style="color:#9AA0A7;font-size:15px;margin-top:8px">深墨青底 + 青色辉光节点 · 缰绳 = 串起 Agent 的链路</div>
    <div style="display:flex;gap:56px;margin-top:52px">
      ${keys.map(k => `
        <div style="text-align:center">
          <div style="width:340px;height:340px;border-radius:77px;overflow:hidden;box-shadow:0 18px 44px rgba(0,0,0,.45)">
            <svg viewBox="0 0 100 100" width="340" height="340">${art[k]}</svg>
          </div>
          <div style="color:#E8EAED;font-size:17px;font-weight:600;margin-top:20px">${meta[k][0]}</div>
          <div style="color:#9AA0A7;font-size:13.5px;margin-top:6px">${meta[k][1]}</div>
        </div>`).join('')}
    </div>
    <div style="display:flex;align-items:flex-end;gap:16px;margin-top:76px;background:rgba(255,255,255,.14);border-radius:26px;padding:20px 26px;width:max-content;backdrop-filter:blur(6px)">
      ${keys.map(k => `<div style="width:92px;height:92px;border-radius:21px;overflow:hidden"><svg viewBox="0 0 100 100" width="92" height="92">${art[k]}</svg></div>`).join('')}
      <div style="width:92px;height:92px;border-radius:50%;background:#1E9BF0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:40px;font-weight:700">S</div>
      <div style="width:92px;height:92px;border-radius:21px;background:#0E1116;display:flex;align-items:center;justify-content:center;font-size:42px">⚡</div>
    </div>
  </div>
</body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1560, height: 940, show: false, frame: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise(r => setTimeout(r, 400));
  fs.writeFileSync(path.join(OUT, 'showcase3.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
});
