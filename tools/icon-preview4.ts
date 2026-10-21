/* 图标 v4：蓝紫 AI 底 + 系统圆体字形（排版级字形，不手搓路径；不部署） */
import { app, BrowserWindow } from 'electron';
import fs = require('fs');
import path = require('path');
const OUT = '/tmp/icon-preview4';
fs.mkdirSync(OUT, { recursive: true });

// 四芒星（凹边曲线星，非直线尖角——更精致）
const sparkle = (x: number, y: number, r: number, fill: string, op = 1) =>
  `<path transform="translate(${x} ${y}) scale(${r / 40})" fill="${fill}" opacity="${op}"
     d="M0 -40 C3 -12 12 -3 40 0 C12 3 3 12 0 40 C-3 12 -12 3 -40 0 C-12 -3 -3 -12 0 -40 Z" />`;

const defs = `<defs>
  <linearGradient id="indigo" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#5B7CFA"/><stop offset="1" stop-color="#7C3AED"/>
  </linearGradient>
  <linearGradient id="indigoDeep" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4F46E5"/><stop offset="1" stop-color="#6D28D9"/>
  </linearGradient>
  <linearGradient id="white" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCD6FF"/>
  </linearGradient>
  <filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.6" /></filter>
</defs>`;

const R = (size: number, dy = 0) =>
  `<text x="50" y="${50 + dy}" text-anchor="middle" dominant-baseline="central"
     font-family="ui-rounded,-apple-system,'SF Pro Rounded','PingFang SC',sans-serif"
     font-weight="800" font-size="${size}" fill="url(#white)">R</text>`;

const art = {
  // J：R 字身 + 右上角悬浮四芒星（字母与 AI 符号共生）
  j: `${defs}<rect width="100" height="100" rx="22.5" fill="url(#indigo)" />
      ${R(58, 1)}${sparkle(74, 22, 9.5, '#FFFFFF')}
      <g opacity=".55">${sparkle(74, 22, 13, '#A5B4FC', .35)}</g>`,
  // K：纯 R 大字身（极简排版派）
  k: `${defs}<rect width="100" height="100" rx="22.5" fill="url(#indigoDeep)" />${R(62)}`,
  // L：纯四芒星主形（无字母，AI 原生符号派，双星层次）
  l: `${defs}<rect width="100" height="100" rx="22.5" fill="url(#indigo)" />
      <g>${sparkle(47, 50, 30, '#C7D2FE', .35)}</g>
      ${sparkle(50, 53, 27, '#FFFFFF')}
      ${sparkle(76, 22, 9, '#E0E7FF')}`,
  // M：R 字身 + 左下小星呼应（对角构图）
  m: `${defs}<rect width="100" height="100" rx="22.5" fill="url(#indigoDeep)" />
      ${R(56, 2)}${sparkle(26, 76, 7.5, '#C7D2FE')}`,
};
const meta = {
  j: ['J · R 与星', '圆体 R + 右上悬浮四芒星'],
  k: ['K · 大字', '纯排版：圆体大 R，什么都不加'],
  l: ['L · 双星', '无字母：主星 + 辉光底星 + 伴星'],
  m: ['M · 对角', 'R + 左下伴星，对角呼应'],
};
const keys = ['j', 'k', 'l', 'm'];

const page = `<!doctype html><body style="margin:0">
  <div style="width:1660px;height:980px;background:linear-gradient(150deg,#15161B 0%,#262B36 60%,#33394A 100%);font-family:-apple-system,'PingFang SC',sans-serif;padding:56px;box-sizing:border-box">
    <div style="color:#E8EAED;font-size:26px;font-weight:700">应用图标 v4 · 蓝紫 AI 底 + 系统圆体字形</div>
    <div style="color:#9AA0A7;font-size:15px;margin-top:8px">换掉青绿 · 字形来自系统字体（排版级质量）· 四芒星为曲线凹边</div>
    <div style="display:flex;gap:44px;margin-top:48px">
      ${keys.map(k => `
        <div style="text-align:center">
          <div style="width:300px;height:300px;border-radius:68px;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,.45)">
            <svg viewBox="0 0 100 100" width="300" height="300">${art[k]}</svg>
          </div>
          <div style="color:#E8EAED;font-size:16px;font-weight:600;margin-top:18px">${meta[k][0]}</div>
          <div style="color:#9AA0A7;font-size:13px;margin-top:5px">${meta[k][1]}</div>
        </div>`).join('')}
    </div>
    <div style="display:flex;align-items:flex-end;gap:14px;margin-top:70px;background:rgba(255,255,255,.13);border-radius:24px;padding:18px 24px;width:max-content">
      ${keys.map(k => `<div style="width:84px;height:84px;border-radius:19px;overflow:hidden"><svg viewBox="0 0 100 100" width="84" height="84">${art[k]}</svg></div>`).join('')}
    </div>
  </div>
</body>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1660, height: 980, show: false, frame: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise(r => setTimeout(r, 450));
  fs.writeFileSync(path.join(OUT, 'showcase4.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
});
