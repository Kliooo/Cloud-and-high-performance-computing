// track.js — Wheatfield Loop track geometry.
// Pure logic with no DOM: imported by both the browser and the Node tests.

export const WORLD = { w: 4352, h: 2448 };
export const TRACK_NAME = 'Wheatfield Loop';

export const ROAD_HALF = 46;   // half the asphalt width
export const CURB_HALF = 52;   // half the width including the kerb
export const GATE_FINISH = 0;  // finish gate id
export const GATE_LAST = 8;    // id of the last sector
export const TOTAL_GATES = 9;  // finish + 8 sectors

// Centreline control points (closed loop, clockwise). A ring of straights,
// chicanes and a LOOP on the top straight: the track dives down, wraps around
// the loop and rejoins the ring over a BRIDGE above its own entry. The road
// crossing is found automatically (findSelfCrossing).
const CONTROL_POINTS = [
  [612, 2040],   // 0 — start/finish, heading right
  [1462, 2176],  // 1 — bottom straight
  [2516, 2193],  // 2
  [3400, 2057],  // 3 — end of the straight
  [3842, 1734],  // 4 — right-hander
  [3650, 1520],  // 5 — flick inward
  [3900, 1400],  // 6 — flick outward
  [3950, 1100],  // 7
  [3700, 780],   // 8 — towards the loop
  [2800, 480],   // 9 — loop entry (dives down, UNDER the bridge)
  [2550, 650],   // 10 — under the bridge
  [2500, 1000],  // 11 — south of the loop
  [2750, 1200],  // 12 — bottom of the loop
  [3050, 1120],  // 13 — east of the loop
  [2900, 620],   // 14 — loop exit (BRIDGE over the entry)
  [2400, 420],   // 15 — back onto the ring
  [1700, 380],   // 16 — top straight heading west
  [1050, 450],   // 17
  [480, 750],    // 18 — top left
  [330, 1250],   // 19 — left side
  [250, 1500],   // 20 — kink left
  [380, 1700],   // 21 — bottom left
];

// Auto-detect the self-crossing (for the bridge): non-adjacent samples closer
// than 40 px. Returns a pair of indices: the road below (i) and the bridge (j).
function findSelfCrossing(samples) {
  const n = samples.length;
  let best = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 70; j < n; j++) {
      if (j - i > n - 70) continue;
      const d = Math.hypot(samples[i].x - samples[j].x, samples[i].y - samples[j].y);
      if (d < 40 && (!best || d < best.d)) best = { i, j, d };
    }
  }
  return best;
}

// Second track — marked up from the user's reference map with the
// tools/pick-points.html helper (80 points, coordinates as map fractions of
// 1600x687). Points go straight into the control list (no resampling), the
// scale is uniform, and start/finish sits wherever the marking began.
const CONTROL_POINTS_CANYON = [
  [2762.6, 1937.4],  // 0 - start/finish (as marked)
  [3043, 1937.4],
  [3335.4, 1934.5],
  [3633.8, 1919.7],
  [3823.1, 1902],
  [3958.7, 1733.5],
  [4047.4, 1559.2],
  [3867.3, 1432.3],
  [3693.2, 1544.4],
  [3483.4, 1609.5],
  [3338.6, 1494.3],
  [3391.6, 1308.1],
  [3503.9, 1181.2],
  [3642.6, 1018.6],
  [3793.5, 867.9],
  [3929.4, 755.8],
  [3899.8, 590.3],
  [3719.7, 510.6],
  [3560, 557.7],
  [3418.4, 661.3],
  [3291.3, 794.2],
  [3205.4, 921.1],
  [3131.6, 1036.4],
  [3081.5, 1163.5],
  [3037.4, 1305.2],
  [3016.5, 1458.8],
  [2984, 1597.6],
  [2854.1, 1603.5],
  [2756.6, 1470.7],
  [2682.8, 1337.8],
  [2576.5, 1296.4],
  [2484.7, 1390.8],
  [2440.5, 1482.4],
  [2372.3, 1568.2],
  [2251.2, 1606.6],
  [2153.7, 1479.5],
  [2174.6, 1293.3],
  [2278.1, 1160.5],
  [2419.7, 1033.4],
  [2564.5, 947.8],
  [2741.8, 871],
  [2883.8, 779.4],
  [2913, 599.1],
  [2712.1, 492.8],
  [2475.8, 495.7],
  [1710.9, 489.9],
  [1542.5, 563.8],
  [1581, 726.2],
  [1752.2, 761.7],
  [1902.6, 823.7],
  [1905.9, 1039.3],
  [1834.9, 1272.7],
  [1722.5, 1435.2],
  [1583.8, 1577],
  [1338.7, 1612.5],
  [1120.1, 1609.5],
  [869, 1588.9],
  [700.5, 1467.6],
  [620.7, 1293.3],
  [609.1, 1086.7],
  [774.3, 995],
  [871.8, 1071.8],
  [919.1, 1216.5],
  [1043.1, 1325.9],
  [1255.7, 1317.1],
  [1456.6, 1305.2],
  [1589.8, 1166.4],
  [1557.3, 1030.5],
  [1368, 953.7],
  [1226.4, 879.8],
  [1143.8, 729.1],
  [1055.1, 569.6],
  [845.3, 510.6],
  [623.5, 613.9],
  [467.1, 717.4],
  [363.6, 862.1],
  [304.6, 1015.7],
  [322.3, 1588.9],
  [478.7, 1795.5],
  [809.6, 1958.1],
];

// Track registry: id, display name (for the dropdown) and points in travel order.
const TRACK_DEFS = [
  { id: 'wheatfield', name: 'Wheatfield Loop', points: CONTROL_POINTS, botLook: { base: 150, skill: 90 } },
  { id: 'canyon', name: 'Copper Canyon', points: CONTROL_POINTS_CANYON, densify: 40, smooth: 1, samplesPerSegment: 9, gates: 16, botLook: { base: 100, skill: 45 } },
];

// Background "figure-eight" for the live menu wallpaper: points of a Gerono
// lemniscate (x = a·cos t, y = (a/2)·sin 2t, a = 1180) — a smooth symmetric shape
// that crosses itself exactly once, at a right angle, in the middle of the world
// (the bridge appears automatically). NOT part of the playable track list.
const CONTROL_POINTS_DEMO8 = [
  [3276, 1224], // t = 0
  [3222, 1547],
  [3066, 1747],
  [2823, 1747],
  [2516, 1547],
  [2176, 1224], // centre (first pass)
  [1836, 901],
  [1529, 701],
  [1286, 701],
  [1130, 901],
  [1076, 1224], // t = π
  [1130, 1547],
  [1286, 1747],
  [1529, 1747],
  [1836, 1547],
  [2176, 1224], // centre (second pass)
  [2516, 901],
  [2823, 701],
  [3066, 701],
  [3222, 901],
];

// Decorations for the background scene: billboards, grandstand and pond are
// placed outside the figure-eight so the menu frame looks finished.
const DEMO_DECOR_OPTIONS = {
  seed: 20260921,
  treeCount: 190,
  haystackCount: 44,
  flowerCount: 430,
  billboards: [
    { x: 735, y: 1224, angle: 0.1, text: 'RETRO COLA' },
    { x: 3620, y: 1224, angle: -0.1, text: 'PITSTOP TYRES' },
    { x: 2176, y: 250, angle: 0.02, text: 'RETRO RALLY' },
  ],
  standCandidates: [
    { x: 3010, y: 1950 },
    { x: 1345, y: 1950 },
    { x: 2176, y: 430 },
    { x: 620, y: 1224 },
  ],
  pondCandidates: [
    { x: 2176, y: 2050 },
    { x: 560, y: 700 },
    { x: 3790, y: 1750 },
  ],
};
export function buildDemoTrack() {
  return {
    roadHalf: ROAD_HALF,
    curbHalf: CURB_HALF,
    ...buildTrackData({
      id: 'demo8',
      name: 'Loop Eight',
      points: CONTROL_POINTS_DEMO8,
      decorOptions: DEMO_DECOR_OPTIONS,
    }),
  };
}

const SAMPLES_PER_SEGMENT = 36;
const SAMPLES = CONTROL_POINTS.length * SAMPLES_PER_SEGMENT; // 720

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

// Split the polyline into short segments so the curve follows the markup
// exactly, without cutting across tight corners.
function densifyPolyline(points, maxSegment) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(d / maxSegment));
    for (let k = 0; k < n; k++) {
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
  }
  return out;
}

// Soft corner rounding: several 1-2-1 smoothing passes. The shape stays on the
// track (a shift of tens of pixels) but the kinks disappear.
function smoothPolyline(points, passes = 1) {
  let cur = points;
  for (let pass = 0; pass < passes; pass++) {
    const n = cur.length;
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      next[i] = [a[0] * 0.25 + b[0] * 0.5 + c[0] * 0.25, a[1] * 0.25 + b[1] * 0.5 + c[1] * 0.25];
    }
    cur = next;
  }
  return cur;
}

function buildSamples(points, perSegment = SAMPLES_PER_SEGMENT) {
  const n = points.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment;
      pts.push({
        x: catmullRom(p0[0], p1[0], p2[0], p3[0], t),
        y: catmullRom(p0[1], p1[1], p2[1], p3[1], t),
        tx: 0,
        ty: 0,
        angle: 0,
      });
    }
  }
  const total = pts.length;
  for (let i = 0; i < total; i++) {
    const prev = pts[(i - 1 + total) % total];
    const next = pts[(i + 1) % total];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    pts[i].tx = dx / len;
    pts[i].ty = dy / len;
    pts[i].angle = Math.atan2(dy, dx);
  }
  return pts;
}

// Deterministic PRNG (identical decoration on every load)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nearestIndexFull(samples, x, y) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function buildDecor(samples, obstacles, crossing, opts = {}) {
  const rand = mulberry32(opts.seed ?? 20260915);
  const decor = {
    trees: [],
    haystacks: [],
    billboards: [],
    grassSpeckles: [],
    asphaltSpeckles: [],
    flowers: [],
    chevrons: [],
    pond: null,
    grandstand: null,
  };

  const distToRoad = (x, y) => {
    const idx = nearestIndexFull(samples, x, y);
    return Math.hypot(samples[idx].x - x, samples[idx].y - y);
  };
  const clearOfObstacles = (x, y, margin) =>
    obstacles.every((o) => Math.hypot(o.x - x, o.y - y) > o.r + margin);
  const clearOfList = (list, x, y, margin) =>
    list.every((item) => Math.hypot(item.x - x, item.y - y) > item.r + margin + 8);

  // Billboards first, so the vegetation cannot cover them
  const billboards = opts.billboards ?? [
    { x: 1632, y: 1122, angle: 0.08, text: 'PITSTOP TYRES' },
    { x: 2584, y: 1632, angle: -0.06, text: 'RETRO COLA' },
    { x: 3400, y: 867, angle: 0.12, text: 'CLOUD GP' },
  ];
  for (const b of billboards) {
    if (distToRoad(b.x, b.y) < 118) continue; // never on the racing line
    decor.billboards.push(b);
  }

// Pond and grandstand are picked from candidates by clearance to the track,
// so they work on any map (including Copper Canyon)
  const pondCandidates = opts.pondCandidates ?? [
    { x: 2720, y: 950 },
    { x: 2380, y: 884 },
    { x: 1050, y: 1300 },
    { x: 3300, y: 1300 },
    { x: 2200, y: 1300 },
    { x: 3350, y: 800 },
    { x: 700, y: 1250 },
    { x: 1500, y: 800 },
    { x: 1850, y: 2225 },
    { x: 3350, y: 2230 },
    { x: 800, y: 2230 },
  ];
  const pondR = 92;
  // clearance is measured from the EDGE of the road, else the pond hugs the asphalt
  const pond = pondCandidates
    .map((c) => ({ ...c, r: pondR }))
    .find((c) => distToRoad(c.x, c.y) >= pondR + ROAD_HALF + 36);
  const standCandidates = opts.standCandidates ?? [
    { x: 1122, y: 1768 },
    { x: 2200, y: 1600 },
    { x: 3300, y: 1600 },
    { x: 700, y: 1500 },
    { x: 1500, y: 900 },
    { x: 3000, y: 900 },
    { x: 900, y: 2100 },
  ];
  const grandstand = standCandidates
    .map((c) => ({ ...c, w: 300, h: 64, angle: -0.05 }))
    .find((c) => distToRoad(c.x, c.y) >= 32 + ROAD_HALF + 46);
  if (pond) decor.pond = pond;
  if (grandstand) decor.grandstand = grandstand;

  // Landmarks own their ground: trees and haystacks keep clear
  const keepClearOfLandmarks = (x, y, margin) => {
    if (decor.pond && Math.hypot(decor.pond.x - x, decor.pond.y - y) < decor.pond.r + 14 + margin) return false;
    if (decor.grandstand && Math.hypot(grandstand.x - x, grandstand.y - y) < 100 + margin) return false;
    for (const b of decor.billboards) {
      if (Math.hypot(b.x - x, b.y - y) < 82 + margin) return false;
    }
    return true;
  };

  // Trees — clusters of dark green circles with a shadow
  let attempts = 0;
  while (decor.trees.length < (opts.treeCount ?? 130) && attempts < 2700) {
    attempts++;
    const x = 40 + rand() * (WORLD.w - 80);
    const y = 40 + rand() * (WORLD.h - 80);
    if (distToRoad(x, y) < 110) continue;
    if (!clearOfObstacles(x, y, 40)) continue;
    if (!clearOfList(decor.trees, x, y, 10)) continue;
    if (!keepClearOfLandmarks(x, y, 12)) continue;
    decor.trees.push({
      x,
      y,
      r: 12 + rand() * 11,
      blobs: Array.from({ length: 3 }, () => ({
        dx: (rand() - 0.5) * 16,
        dy: (rand() - 0.5) * 16,
        r: 8 + rand() * 8,
      })),
    });
  }

  // Haystacks
  attempts = 0;
  while (decor.haystacks.length < (opts.haystackCount ?? 36) && attempts < 1800) {
    attempts++;
    const x = 60 + rand() * (WORLD.w - 120);
    const y = 60 + rand() * (WORLD.h - 120);
    if (distToRoad(x, y) < 80) continue;
    if (!clearOfObstacles(x, y, 30)) continue;
    if (!clearOfList(decor.trees, x, y, 6)) continue;
    if (!clearOfList(decor.haystacks, x, y, 6)) continue;
    if (!keepClearOfLandmarks(x, y, 10)) continue;
    decor.haystacks.push({ x, y, r: 12 + rand() * 7 });
  }

  // Flowers on the lawn
  attempts = 0;
  while (decor.flowers.length < (opts.flowerCount ?? 260) && attempts < 2400) {
    attempts++;
    const x = 30 + rand() * (WORLD.w - 60);
    const y = 30 + rand() * (WORLD.h - 60);
    if (distToRoad(x, y) < 70) continue;
    if (!keepClearOfLandmarks(x, y, 8)) continue;
    decor.flowers.push({ x, y, tone: rand() < 0.5 ? 0 : 1, r: 1.6 + rand() * 1.6 });
  }

  // Chevron arrows on the asphalt (direction of travel): on the straights and at the loop/bridge
  decor.chevrons = [100, 300, 500, 640].map((index) => ({ index: index % samples.length }));
  if (crossing) {
    // prominent arrows at the under-bridge entry and the loop exit
    decor.chevrons.push(
      { index: (crossing.i - 10 + samples.length) % samples.length },
      { index: (crossing.i - 3 + samples.length) % samples.length },
      { index: (crossing.i + 3) % samples.length },
      { index: (crossing.j - 10 + samples.length) % samples.length },
      { index: (crossing.j + 3) % samples.length },
    );
  }

  // Speckles on the grass
  for (let i = 0; i < 1800; i++) {
    decor.grassSpeckles.push({
      x: rand() * WORLD.w,
      y: rand() * WORLD.h,
      r: 1 + rand() * 2.4,
      tone: rand() < 0.5 ? 0 : 1,
    });
  }

  // Light speckles on the asphalt (close to the centreline)
  attempts = 0;
  while (decor.asphaltSpeckles.length < 700 && attempts < 3500) {
    attempts++;
    const idx = Math.floor(rand() * samples.length);
    const s = samples[idx];
    const off = (rand() - 0.5) * 2 * (ROAD_HALF - 8);
    const x = s.x - s.ty * off;
    const y = s.y + s.tx * off;
    decor.asphaltSpeckles.push({ x, y, r: 1 + rand() * 1.8, tone: rand() < 0.5 ? 0 : 1 });
  }

  return decor;
}

// Sectors spread evenly along the track (on the big map the hairpin leaves room
// for the posts — verified by the post-on-road self test).

// Sector 6 is moved clear of the bridge deck (otherwise its line ends up under it).
const GATE_INDEX_OVERRIDE = { wheatfield: { 6: 480 } };
function buildGates(samples, trackId, bridgeRange, gateCount = TOTAL_GATES) {
  const override = GATE_INDEX_OVERRIDE[trackId] || {};
  const gates = [];
  for (let k = 0; k < gateCount; k++) {
    let index = (override[k] ?? Math.round((k * samples.length) / gateCount)) % samples.length;
    // a sector must not sit on the bridge (it would clash with the deck)
    if (bridgeRange && override[k] === undefined) {
      let guard = 0;
      while (
        index >= bridgeRange.from - 6 &&
        index <= bridgeRange.to + 6 &&
        guard++ < 40
      ) {
        index = (index + 12) % samples.length;
      }
    }
    const s = samples[index];
    gates.push({ id: k, index, x: s.x, y: s.y, r: 60, tx: s.tx, ty: s.ty });
  }
  return gates;
}

// Sector marker posts: a pair at the road edges for each sector (radius 10).
// Where a sharp corner leaves no room (an adjacent arm of the track is too
// close), a post slides along the verge until it finds a valid spot; the
// positions are attached to the gate (gate.posts) so the renderer can draw the
// sector number.
function buildGatePosts(gates, samples) {
  const MIN_CLEAR = 52;   // from a post's centre to any point on the centreline
  const EDGE_OFFSET = 58; // road edge (46) + 12

  const distToRoad = (x, y) => {
    let best = Infinity;
    for (const s of samples) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < best) best = d;
    }
    return best;
  };

  const posts = [];
  for (const gate of gates) {
    gate.posts = [];
    if (gate.id === GATE_FINISH) continue; // the finish is the chequered line
    // 1) slide the WHOLE station (the post pair) until both have room at the
    //    edges — then the line always sits exactly between the two posts
    let paired = false;
    search: for (let k = 0; k <= 25; k++) {
      for (const dir of (k === 0 ? [0] : [k, -k])) {
        const idx = ((gate.index + dir) % samples.length + samples.length) % samples.length;
        const s = samples[idx];
        const nx = -s.ty;
        const ny = s.tx;
        const pA = { x: s.x + nx * EDGE_OFFSET, y: s.y + ny * EDGE_OFFSET, r: 10, index: idx };
        const pB = { x: s.x - nx * EDGE_OFFSET, y: s.y - ny * EDGE_OFFSET, r: 10, index: idx };
        if (distToRoad(pA.x, pA.y) >= MIN_CLEAR && distToRoad(pB.x, pB.y) >= MIN_CLEAR) {
          gate.index = idx;
          gate.x = s.x;
          gate.y = s.y;
          gate.tx = s.tx;
          gate.ty = s.ty;
          gate.posts = [pA, pB];
          posts.push(pA, pB);
          paired = true;
          break search;
        }
      }
    }
    // 2) fallback: position the posts individually, each sliding on its own
    if (!paired) {
      for (const side of [1, -1]) {
        for (let k = 0; k <= 25; k++) {
          for (const dir of (k === 0 ? [0] : [k, -k])) {
            const idx = ((gate.index + dir) % samples.length + samples.length) % samples.length;
            const s = samples[idx];
            const nx = -s.ty;
            const ny = s.tx;
            const x = s.x + nx * EDGE_OFFSET * side;
            const y = s.y + ny * EDGE_OFFSET * side;
            if (distToRoad(x, y) >= MIN_CLEAR) {
              const post = { x, y, r: 10, index: idx };
              gate.posts.push(post);
              posts.push(post);
              k = 99;
              break;
            }
          }
        }
      }
    }
  }
  return posts;
}

function buildTrackData(def) {
  let srcPoints = def.densify ? densifyPolyline(def.points, def.densify) : def.points;
  if (def.smooth) srcPoints = smoothPolyline(srcPoints, def.smooth);
  const samples = buildSamples(srcPoints, def.samplesPerSegment);
  const crossing = findSelfCrossing(samples);
  const bridgeRange = crossing ? { from: crossing.j - 13, to: crossing.j + 13 } : null;
  const gates = buildGates(samples, def.id, bridgeRange, def.gates ?? TOTAL_GATES);
  const obstacles = buildGatePosts(gates, samples);
  const decor = buildDecor(samples, [], crossing, def.decorOptions || {});
  // mean sample spacing: bot lookahead and the start grid are derived from it
  let perimeter = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return {
    id: def.id,
    name: def.name,
    botLook: def.botLook || null,
    samples,
    spacing: perimeter / samples.length,
    gates,
    obstacles,
    decor,
    bridgeRange: crossing ? { from: crossing.j - 13, to: crossing.j + 13 } : null,
    underRange: crossing ? { from: crossing.i - 8, to: crossing.i + 8 } : null,
    crossing: crossing ? { x: samples[crossing.j].x, y: samples[crossing.j].y } : null,
    spawn: {
      x: samples[0].x,
      y: samples[0].y,
      angle: samples[0].angle,
      index: 0,
    },
  };
}

export const TRACK_LIST = TRACK_DEFS.map((d) => ({ id: d.id, name: d.name }));

export const TRACK = {
  roadHalf: ROAD_HALF,
  curbHalf: CURB_HALF,
  ...buildTrackData(TRACK_DEFS[0]),
};

// Track switching (single player dropdown).
export function setTrack(id) {
  const def = TRACK_DEFS.find((d) => d.id === id);
  if (!def || TRACK.id === def.id) return false;
  Object.assign(TRACK, buildTrackData(def));
  return true;
}

// Start grid for 4 cars (behind the finish line): used both for drawing the grid
// boxes and for placing the player among the bots. The setback is given in pixels
// (converted to samples via the track spacing), otherwise cars on tracks with
// dense samples end up touching.
export const START_GRID = [
  { backPx: 98, lat: -24 },
  { backPx: 98, lat: 24 },
  { backPx: 210, lat: -24 },
  { backPx: 210, lat: 24 },
];

export function gridSpawn(track, slot) {
  const s0 = START_GRID[slot % START_GRID.length];
  const n = track.samples.length;
  const spacing = track.spacing || 14;
  const back = Math.max(1, Math.round(s0.backPx / spacing));
  const idx = (n - back) % n;
  const s = track.samples[idx];
  const nx = -s.ty;
  const ny = s.tx;
  return { x: s.x + nx * s0.lat, y: s.y + ny * s0.lat, angle: s.angle, index: idx };
}

// Nearest centreline point. hint is last frame's index (speeds up the search).
export function nearestSample(track, x, y, hint = -1) {
  const samples = track.samples;
  const total = samples.length;
  let bestIndex = -1;
  let bestDistSq = Infinity;

  if (hint >= 0 && hint < total) {
    const window = 80;
    for (let k = -window; k <= window; k++) {
      const i = ((hint + k) % total + total) % total;
      const s = samples[i];
      const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestIndex = i;
      }
    }
    if (Math.sqrt(bestDistSq) > 220) {
      bestIndex = -1;
      bestDistSq = Infinity;
    }
  }

  if (bestIndex < 0) {
    for (let i = 0; i < total; i++) {
      const s = samples[i];
      const d = (s.x - x) * (s.x - x) + (s.y - y) * (s.y - y);
      if (d < bestDistSq) {
        bestDistSq = d;
        bestIndex = i;
      }
    }
  }

  const s = samples[bestIndex];
  return {
    index: bestIndex,
    dist: Math.sqrt(bestDistSq),
    x: s.x,
    y: s.y,
    tx: s.tx,
    ty: s.ty,
    angle: s.angle,
  };
}

export function isOnRoad(track, x, y, hint = -1) {
  return nearestSample(track, x, y, hint).dist <= track.roadHalf;
}

// Checkpoints: sectors strictly in order, the finish only after all of them.
export function createCheckpointTracker(track) {
  let expected = 1;
  let lastPassed = GATE_FINISH;
  let lastSkipTime = -Infinity;
  let lastSkipGate = -1;

  return {
    get expected() {
      return expected;
    },
    reset() {
      expected = 1;
      lastPassed = GATE_FINISH;
      lastSkipTime = -Infinity;
      lastSkipGate = -1;
    },
    update(x, y, nowMs = 0) {
      const events = [];
      for (const gate of track.gates) {
        const d = Math.hypot(x - gate.x, y - gate.y);
        if (d > gate.r) continue;
        if (gate.id === expected) {
          events.push({ type: 'gate', gate: gate.id });
          lastPassed = gate.id;
          expected = gate.id === track.gates.length - 1 ? GATE_FINISH : gate.id + 1;
        } else if (
          gate.id > expected &&
          gate.id !== GATE_FINISH &&
          gate.id !== lastPassed &&
          expected !== GATE_FINISH
        ) {
          if (!(gate.id === lastSkipGate && nowMs - lastSkipTime < 2500)) {
            events.push({ type: 'skip', expected, at: gate.id });
            lastSkipTime = nowMs;
            lastSkipGate = gate.id;
          }
        }
      }
      return events;
    },
  };
}

export function formatLap(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—:——.———';
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msec = total % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(msec).padStart(3, '0')}`;
}
