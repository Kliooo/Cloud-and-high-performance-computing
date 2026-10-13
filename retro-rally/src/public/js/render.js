// render.js — procedural drawing: track, car, skids, particles, camera.
// Style: the "08 Resn" preset — warm illustrative warmth, thick outlines, hard shadows.

import { WORLD, ROAD_HALF, CURB_HALF, START_GRID } from './track.js';

export const PALETTE = {
  paper: '#F7EBD3',
  ink: '#2B2118',
  racing: '#E8542F',
  gold: '#F2B33D',
  grass: '#8AB653',
  grassDark: '#6E9A3C',
  asphalt: '#52525C',
  asphaltLight: '#6B6B76',
  tree: '#3E6B3A',
  panel: '#FFF8EC',
};

const HUD_FONT = '"Arial Black", "Segoe UI", system-ui, sans-serif';

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

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
}

// ---------- Sector lines ----------
// A translucent line across the road on every sector not yet passed. Crossed, the
// line disappears; on a new lap they all come back. A skipped sector blinks red,
// with the sector number on the post at the right-hand edge.

function drawGateLines(ctx, track, gateState) {
  const { pendingFrom, flash, now } = gateState;
  if (pendingFrom === null || pendingFrom === undefined) return;

  for (const gate of track.gates) {
    if (gate.id === 0) continue; // the finish is the chequered line, drawn in the static layer
    const pending = pendingFrom === 0 ? false : gate.id >= pendingFrom;
    if (!pending) continue;

    const flashing = !!(flash && flash.id === gate.id && now < flash.until);
    const alpha = flashing ? (Math.floor(now / 130) % 2 === 0 ? 0.85 : 0.25) : 0.42;

    const nx = -gate.ty;
    const ny = gate.tx;
    const half = track.roadHalf;

    ctx.lineCap = 'round';
    ctx.strokeStyle = flashing ? `rgba(232,84,47,${alpha})` : `rgba(242,179,61,${alpha})`;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(gate.x + nx * half, gate.y + ny * half);
    ctx.lineTo(gate.x - nx * half, gate.y - ny * half);
    ctx.stroke();

    ctx.strokeStyle = flashing ? `rgba(255,248,236,${Math.min(1, alpha * 0.95)})` : `rgba(255,248,236,${alpha * 0.7})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(gate.x + nx * half, gate.y + ny * half);
    ctx.lineTo(gate.x - nx * half, gate.y - ny * half);
    ctx.stroke();

    // sector number on the post at the road edge
    const anchor = (gate.posts && gate.posts[0]) || { x: gate.x + nx * 58, y: gate.y + ny * 58 };
    const bx = anchor.x;
    const by = anchor.y;
    ctx.fillStyle = PALETTE.panel;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 2.5;
    circle(ctx, bx, by, 9.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = PALETTE.ink;
    ctx.font = `800 11px ${HUD_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(gate.id), bx, by + 0.5);
  }
}

// ---------- Static track (drawn once into an offscreen canvas) ----------

function drawFinishLine(ctx, track) {
  const s = track.samples[0];
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  const cell = 9.2;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 10; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? PALETTE.ink : PALETTE.paper;
      ctx.fillRect(-cell + row * cell, -ROAD_HALF + col * cell, cell, cell);
    }
  }
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(-cell, -ROAD_HALF, cell * 2, ROAD_HALF * 2);
  ctx.restore();
}

function drawBillboard(ctx, b) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.angle);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(-42, 10, 9, 30);
  ctx.fillRect(33, 10, 9, 30);
  ctx.fillStyle = PALETTE.gold;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  roundRectPath(ctx, -64, -28, 128, 42, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PALETTE.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 15;
  ctx.font = `800 ${size}px ${HUD_FONT}`;
  while (ctx.measureText(b.text).width > 112 && size > 9) {
    size -= 1;
    ctx.font = `800 ${size}px ${HUD_FONT}`;
  }
  ctx.fillText(b.text, 0, -6);
  ctx.restore();
}

export function buildTrackCanvas(track) {
  // Round joins and caps, otherwise the asphalt grows sharp spikes at the kinks.
  // Track canvas at full resolution (quality matters more than memory)
  const SCALE = 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(WORLD.w * SCALE);
  canvas.height = Math.round(WORLD.h * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.scale(SCALE, SCALE);
  const decor = track.decor;

  // Grass: warm green with diagonal stripes
  ctx.fillStyle = PALETTE.grass;
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);
  ctx.save();
  ctx.translate(WORLD.w / 2, WORLD.h / 2);
  ctx.rotate(-Math.PI / 6);
  ctx.fillStyle = PALETTE.grassDark;
  for (let x = -1400; x < 1400; x += 132) {
    ctx.fillRect(x, -1400, 66, 2800);
  }
  ctx.restore();

  for (const sp of decor.grassSpeckles) {
    ctx.fillStyle = sp.tone ? 'rgba(43,33,24,0.13)' : 'rgba(255,248,236,0.22)';
    circle(ctx, sp.x, sp.y, sp.r);
    ctx.fill();
  }

  // Road: red-white kerb, asphalt on top
  const road = new Path2D();
  track.samples.forEach((s, i) => {
    if (i === 0) road.moveTo(s.x, s.y);
    else road.lineTo(s.x, s.y);
  });
  road.closePath();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.strokeStyle = PALETTE.racing;
  ctx.lineWidth = CURB_HALF * 2;
  ctx.stroke(road);

  ctx.strokeStyle = PALETTE.paper;
  ctx.setLineDash([26, 26]);
  ctx.lineWidth = CURB_HALF * 2;
  ctx.stroke(road);
  ctx.setLineDash([]);

  ctx.strokeStyle = PALETTE.asphalt;
  ctx.lineWidth = ROAD_HALF * 2;
  ctx.stroke(road);

  for (const sp of decor.asphaltSpeckles) {
    ctx.fillStyle = sp.tone ? 'rgba(255,248,236,0.10)' : 'rgba(43,33,24,0.12)';
    circle(ctx, sp.x, sp.y, sp.r);
    ctx.fill();
  }

  // wear along the racing line
  ctx.strokeStyle = 'rgba(43,33,24,0.08)';
  ctx.lineWidth = 30;
  ctx.stroke(road);

  // chevron arrows — direction of travel
  for (const c of decor.chevrons) {
    const s = track.samples[c.index % track.samples.length];
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.strokeStyle = 'rgba(247,235,211,0.4)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const dx of [-8, 3]) {
      ctx.beginPath();
      ctx.moveTo(dx, -10);
      ctx.lineTo(dx + 9, 0);
      ctx.lineTo(dx, 10);
      ctx.stroke();
    }
    ctx.restore();
  }

  // starting grid boxes behind the finish line
  for (const slot of START_GRID) {
    const spacing = track.spacing || 14;
    const back = Math.max(1, Math.round(slot.backPx / spacing));
    const slotIdx = (track.samples.length - back) % track.samples.length;
    const s = track.samples[slotIdx];
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.strokeStyle = 'rgba(247,235,211,0.55)';
    ctx.lineWidth = 2.5;
    roundRectPath(ctx, -19, slot.lat - 12, 38, 24, 4);
    ctx.stroke();
    ctx.restore();
  }

  ctx.strokeStyle = 'rgba(247,235,211,0.7)';
  ctx.lineWidth = 4;
  ctx.setLineDash([22, 30]);
  ctx.stroke(road);
  ctx.setLineDash([]);

  // pond with a sandy shore
  if (decor.pond) {
    const p = decor.pond;
    ctx.fillStyle = '#D9C48F';
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 2.5;
    circle(ctx, p.x, p.y, p.r + 9);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#8FB6C9';
    circle(ctx, p.x, p.y, p.r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,248,236,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x - 10, p.y - 6, p.r * 0.55, Math.PI * 1.1, Math.PI * 1.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x + 8, p.y + 4, p.r * 0.35, Math.PI * 1.1, Math.PI * 1.7);
    ctx.stroke();
  }

  // grandstand by the main straight
  if (decor.grandstand) {
    const g = decor.grandstand;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.angle);
    ctx.fillStyle = 'rgba(43,33,24,0.25)';
    ctx.fillRect(-g.w / 2 + 5, -g.h / 2 + 7, g.w, g.h);
    ctx.fillStyle = PALETTE.racing;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 3;
    roundRectPath(ctx, -g.w / 2, -g.h / 2 - 6, g.w, 14, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#E7D9B8';
    ctx.lineWidth = 2.5;
    roundRectPath(ctx, -g.w / 2, -g.h / 2 + 8, g.w, g.h - 8, 4);
    ctx.fill();
    ctx.stroke();
    const crowd = [PALETTE.racing, PALETTE.gold, PALETTE.tree, PALETTE.ink];
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 24; i++) {
        ctx.fillStyle = crowd[(i + row) % crowd.length];
        circle(ctx, -g.w / 2 + 12 + i * (g.w - 24) / 23, -g.h / 2 + 20 + row * 13, 4.5);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Haystacks
  for (const h of decor.haystacks) {
    ctx.fillStyle = PALETTE.gold;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 2.5;
    circle(ctx, h.x, h.y, h.r);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(43,33,24,0.4)';
    ctx.lineWidth = 1.5;
    circle(ctx, h.x, h.y, h.r * 0.55);
    ctx.stroke();
  }

  // Advertising billboards
  for (const b of decor.billboards) {
    drawBillboard(ctx, b);
  }

  // flowers on the lawn
  for (const f of decor.flowers) {
    ctx.fillStyle = f.tone ? PALETTE.gold : PALETTE.panel;
    circle(ctx, f.x, f.y, f.r);
    ctx.fill();
  }

  // trees (with a shadow on the grass)
  for (const t of decor.trees) {
    ctx.fillStyle = 'rgba(43,33,24,0.16)';
    ctx.beginPath();
    ctx.ellipse(t.x + 5, t.y + 6, t.r * 1.15, t.r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    for (const blob of t.blobs) {
      ctx.fillStyle = PALETTE.tree;
      ctx.strokeStyle = PALETTE.ink;
      ctx.lineWidth = 2;
      circle(ctx, t.x + blob.dx, t.y + blob.dy, blob.r);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,248,236,0.28)';
    circle(ctx, t.x - t.r * 0.3, t.y - t.r * 0.35, t.r * 0.32);
    ctx.fill();
  }

  // Tyre stacks
  for (const o of track.obstacles) {
    ctx.fillStyle = PALETTE.ink;
    circle(ctx, o.x, o.y, o.r);
    ctx.fill();
    ctx.strokeStyle = PALETTE.paper;
    ctx.lineWidth = 3;
    circle(ctx, o.x, o.y, o.r - 3.5);
    ctx.stroke();
    ctx.fillStyle = PALETTE.gold;
    circle(ctx, o.x, o.y, 3.2);
    ctx.fill();
  }

  drawFinishLine(ctx, track);

  return canvas;
}

// Bridge deck — a separate layer drawn ABOVE cars on the road below
export function buildBridgeCanvas(track) {
  const range = track.bridgeRange;
  if (!range) return null;
  const deck = track.samples.slice(range.from, range.to + 1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of deck) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  }
  const pad = CURB_HALF + 24;
  const ox = Math.floor(minX - pad);
  const oy = Math.floor(minY - pad);
  const w = Math.ceil(maxX - minX) + pad * 2;
  const h = Math.ceil(maxY - minY) + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.translate(-ox, -oy);

  const path = new Path2D();
  deck.forEach((s, i) => (i === 0 ? path.moveTo(s.x, s.y) : path.lineTo(s.x, s.y)));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // railings along both edges
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 7;
  for (const side of [1, -1]) {
    ctx.beginPath();
    deck.forEach((s, i) => {
      const nx = -s.ty;
      const ny = s.tx;
      const x = s.x + nx * (ROAD_HALF + 10) * side;
      const y = s.y + ny * (ROAD_HALF + 10) * side;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // deck: kerb + asphalt + centre line
  ctx.strokeStyle = PALETTE.racing;
  ctx.lineWidth = CURB_HALF * 2;
  ctx.stroke(path);
  ctx.strokeStyle = PALETTE.paper;
  ctx.setLineDash([24, 24]);
  ctx.lineWidth = CURB_HALF * 2;
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.strokeStyle = PALETTE.asphalt;
  ctx.lineWidth = ROAD_HALF * 2;
  ctx.stroke(path);
  ctx.strokeStyle = 'rgba(247,235,211,0.7)';
  ctx.lineWidth = 4;
  ctx.setLineDash([20, 26]);
  ctx.stroke(path);
  ctx.setLineDash([]);

  // railing posts
  ctx.fillStyle = PALETTE.ink;
  for (let i = 0; i < deck.length; i += 6) {
    const s = deck[i];
    const nx = -s.ty;
    const ny = s.tx;
    for (const side of [1, -1]) {
      circle(ctx, s.x + nx * (ROAD_HALF + 10) * side, s.y + ny * (ROAD_HALF + 10) * side, 5);
      ctx.fill();
    }
  }

  return { canvas, ox, oy };
}


// ---------- Dynamics ----------

function drawCar(ctx, car) {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);

  // shadow
  ctx.fillStyle = 'rgba(43,33,24,0.28)';
  roundRectPath(ctx, -19, -8, 38, 19, 7);
  ctx.fill();

  // wheels (rear + steering front)
  ctx.fillStyle = PALETTE.ink;
  roundRectPath(ctx, -16, -12, 9, 5, 2);
  ctx.fill();
  roundRectPath(ctx, -16, 7, 9, 5, 2);
  ctx.fill();
  ctx.save();
  ctx.translate(10, -9);
  ctx.rotate(car.steer * 0.45);
  roundRectPath(ctx, -4.5, -2.5, 9, 5, 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(10, 9);
  ctx.rotate(car.steer * 0.45);
  roundRectPath(ctx, -4.5, -2.5, 9, 5, 2);
  ctx.fill();
  ctx.restore();

  // body
  ctx.fillStyle = car.color || PALETTE.racing;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  roundRectPath(ctx, -18, -9, 36, 18, 6);
  ctx.fill();
  ctx.stroke();

  // racing stripe
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(-15, -2, 30, 4);

  // cabin
  ctx.fillStyle = PALETTE.gold;
  ctx.lineWidth = 2;
  roundRectPath(ctx, -9, -6, 15, 12, 4);
  ctx.fill();
  ctx.stroke();

  // windscreen
  ctx.fillStyle = PALETTE.paper;
  roundRectPath(ctx, 5, -5, 4.5, 10, 2);
  ctx.fill();

  // headlights
  ctx.fillStyle = PALETTE.paper;
  circle(ctx, 16.5, -5, 2);
  ctx.fill();
  circle(ctx, 16.5, 5, 2);
  ctx.fill();

  // brake lights
  if (car.braking) {
    ctx.fillStyle = PALETTE.ink;
    circle(ctx, -17.5, -4.5, 2);
    ctx.fill();
    circle(ctx, -17.5, 4.5, 2);
    ctx.fill();
  }

  ctx.restore();
}

export function drawWorld(ctx, scene) {
  const { track, trackCanvas, bridge, car, skids, particles, camera, shakeX, shakeY, gateState } = scene;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const range = track.bridgeRange;
  const onBridge = (c) => !!range && c.hint >= range.from && c.hint <= range.to;
  const groundBots = [];
  const bridgeBots = [];
  for (const b of scene.bots || []) (onBridge(b) ? bridgeBots : groundBots).push(b);
  const playerOnBridge = onBridge(car);

  ctx.save();
  ctx.translate(ctx.canvas.width / 2 + shakeX, ctx.canvas.height / 2 + shakeY);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  // only the visible part of the track canvas is drawn (full resolution)
  const TRACK_SCALE = 1;
  const viewW = ctx.canvas.width / camera.zoom + 4;
  const viewH = ctx.canvas.height / camera.zoom + 4;
  const sx = Math.max(0, Math.min(WORLD.w - 1, camera.x - viewW / 2));
  const sy = Math.max(0, Math.min(WORLD.h - 1, camera.y - viewH / 2));
  const sw = Math.min(viewW, WORLD.w - sx);
  const sh = Math.min(viewH, WORLD.h - sy);
  ctx.drawImage(
    trackCanvas,
    sx * TRACK_SCALE,
    sy * TRACK_SCALE,
    sw * TRACK_SCALE,
    sh * TRACK_SCALE,
    sx,
    sy,
    sw,
    sh
  );

  if (gateState) drawGateLines(ctx, track, gateState);

  // skid marks
  ctx.lineCap = 'round';
  for (const s of skids) {
    ctx.strokeStyle = `rgba(43,33,24,${s.alpha.toFixed(3)})`;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(s.x - Math.cos(s.angle) * 3.5, s.y - Math.sin(s.angle) * 3.5);
    ctx.lineTo(s.x + Math.cos(s.angle) * 3.5, s.y + Math.sin(s.angle) * 3.5);
    ctx.stroke();
  }

  // particles (dust/smoke)
  for (const p of particles) {
    ctx.fillStyle = `rgba(${p.color},${p.alpha.toFixed(3)})`;
    circle(ctx, p.x, p.y, p.r);
    ctx.fill();
  }

  // bots: cars plus name plates (the player is drawn last, on top)
  for (const bot of scene.bots || []) {
    drawCar(ctx, bot);
    if (scene.hideBotNames) continue;
    ctx.save();
    ctx.translate(bot.x, bot.y - 26);
    ctx.fillStyle = 'rgba(43,33,24,0.78)';
    roundRectPath(ctx, -26, -9, 52, 15, 5);
    ctx.fill();
    ctx.fillStyle = PALETTE.paper;
    ctx.font = `800 10px ${HUD_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bot.name, 0, 0);
    ctx.restore();
  }

  drawCar(ctx, car);

  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
