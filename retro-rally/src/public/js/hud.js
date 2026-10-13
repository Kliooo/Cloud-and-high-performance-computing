// hud.js — in-race canvas HUD: lap timer, speedometer, countdown, toasts.

import { PALETTE } from './render.js';
import { formatLap } from './track.js';

const FONT = '"Arial Black", "Segoe UI", system-ui, sans-serif';

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = PALETTE.ink;
  roundRectPath(ctx, x + 4, y + 5, w, h, 12);
  ctx.fill();
  ctx.fillStyle = PALETTE.panel;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  roundRectPath(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.stroke();
}

export function drawHud(ctx, hud) {
  const W = ctx.canvas.width;

  // --- Lap panel ---
  if (hud.state === 'racing' || hud.state === 'countdown' || hud.state === 'paused') {
    const showPos = hud.pos && hud.pos.total > 1;
    panel(ctx, 18, 18, 252, showPos ? 164 : 142);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    ctx.fillStyle = PALETTE.ink;
    ctx.font = `800 21px ${FONT}`;
    ctx.fillText(`LAP ${hud.lap}/${hud.totalLaps}`, 36, 44);

    ctx.font = `800 17px ${FONT}`;
    ctx.fillStyle = PALETTE.racing;
    ctx.fillText(`TIME  ${formatLap(hud.currentMs)}`, 36, 72);

    ctx.fillStyle = PALETTE.gold;
    ctx.font = `800 15px ${FONT}`;
    if (showPos) ctx.fillText(`POS   ${hud.pos.rank}/${hud.pos.total}`, 36, 97);

    ctx.fillStyle = PALETTE.ink;
    ctx.font = `700 14px ${FONT}`;
    ctx.fillText(`LAST  ${formatLap(hud.lastMs)}`, 36, showPos ? 121 : 97);
    ctx.fillText(`BEST  ${formatLap(hud.bestMs)}`, 36, showPos ? 143 : 120);
  }

  // --- Speedometer ---
  if (hud.state === 'racing' || hud.state === 'countdown') {
    const cx = W - 88;
    const cy = 632;
    const r = 52;
    ctx.fillStyle = PALETTE.ink;
    ctx.beginPath();
    ctx.arc(cx + 3, cy + 4, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.panel;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const speed = Math.min(1, hud.speed / 440);
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    ctx.strokeStyle = PALETTE.grassDark;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r - 12, start, start + sweep);
    ctx.stroke();
    ctx.strokeStyle = PALETTE.racing;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 12, start, start + sweep * speed);
    ctx.stroke();

    ctx.fillStyle = PALETTE.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 20px ${FONT}`;
    ctx.fillText(String(Math.round(hud.speed * 0.35)), cx, cy - 4);
    ctx.font = `700 10px ${FONT}`;
    ctx.fillText('KM/H', cx, cy + 16);
  }

  // --- Countdown ---
  if (hud.state === 'countdown' && hud.countdownLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const scale = 1 + (1 - (hud.countdownFrac ?? 1)) * 0.25;
    ctx.save();
    ctx.translate(W / 2, 300);
    ctx.scale(scale, scale);
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `800 96px ${FONT}`;
    ctx.fillText(hud.countdownLabel, 4, 6);
    ctx.fillStyle = hud.countdownLabel === 'GO!' ? PALETTE.racing : PALETTE.gold;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 4;
    ctx.fillText(hud.countdownLabel, 0, 0);
    ctx.strokeText(hud.countdownLabel, 0, 0);
    ctx.restore();
  }

  // --- Toast ---
  if (hud.toast && hud.toast.age < hud.toast.ttl) {
    const t = hud.toast;
    const fadeIn = Math.min(1, t.age / 120);
    const fadeOut = Math.min(1, (t.ttl - t.age) / 260);
    const alpha = Math.min(fadeIn, fadeOut);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 26px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(t.text).width + 56;
    panel(ctx, W / 2 - width / 2, 92, width, 54);
    ctx.fillStyle = PALETTE.racing;
    ctx.fillText(t.text, W / 2, 120);
    ctx.restore();
  }

  // --- Mute indicator ---
  if (hud.muted) {
    ctx.fillStyle = 'rgba(43,33,24,0.75)';
    ctx.font = `800 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('SOUND OFF (M)', 20, 668);
  }
}
