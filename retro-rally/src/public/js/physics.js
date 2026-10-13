// physics.js — arcade car model (pure logic, no DOM).
// Speed is split into forward/lateral in body coordinates; grip bleeds off the
// lateral component, and the handbrake drops grip so the car drifts.

import { WORLD, nearestSample } from './track.js';

export const PHYS = {
  ACCEL_ROAD: 320,        // px/s^2 on asphalt
  ACCEL_GRASS: 170,
  BRAKE: 560,             // braking while moving forward
  REVERSE_ACCEL: 220,     // reverse acceleration
  MAX_SPEED_ROAD: 414,    // px/s — the speedometer settles at 145 km/h
  MAX_SPEED_GRASS: 196,
  MAX_REVERSE: 150,
  DRAG_ROAD: 0.5,         // drag, 1/s
  DRAG_GRASS: 1.0,
  GRIP_ROAD: 8.5,         // lateral slip bleed rate, 1/s
  GRIP_GRASS: 4.5,
  GRIP_HANDBRAKE: 1.7,
  OMEGA_MAX: 4.2,         // rad/s at full lock
  TURN_SPEED_WINDOW: 200, // speed at which steering reaches full authority
  HANDBRAKE_TURN_BOOST: 1.25,
  RESTITUTION: 0.35,      // bounce off obstacles
  HIT_SPEED_LOSS: 0.82,   // speed lost on impact
  CAR_RADIUS: 11,         // body collision radius
  WALL_BOUND: 14,         // inset from the world edges
  WALL_RESTITUTION: 0.5,  // soft world-edge bounce: keeps ~55% of the speed
  CAR_CONTACT_MIN: 32,    // distance at which cars shove each other
};

export function createCar(track, spawnPoint = track.spawn) {
  const s = spawnPoint;
  return {
    x: s.x,
    y: s.y,
    angle: s.angle,
    vx: 0,
    vy: 0,
    steer: 0,
    onRoad: true,
    slip: 0,
    hint: s.index ?? 0,
    speedFactor: 1,
  };
}

export function carSpeed(car) {
  return Math.hypot(car.vx, car.vy);
}

export function forwardSpeed(car) {
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  return car.vx * cos + car.vy * sin;
}

// input: { throttle: 0..1, brake: 0..1, steer: -1..1, handbrake: bool }
// Returns a collision event name or null.
export function stepCar(car, input, dt, track) {
  const ns = nearestSample(track, car.x, car.y, car.hint);
  car.hint = ns.index;
  const onRoad = ns.dist <= track.roadHalf;
  car.onRoad = onRoad;

  const cap = car.speedFactor || 1;
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  let vF = car.vx * cos + car.vy * sin;
  let vL = -car.vx * sin + car.vy * cos;

  const accel = (onRoad ? PHYS.ACCEL_ROAD : PHYS.ACCEL_GRASS) * cap;
  const maxSpeed = (onRoad ? PHYS.MAX_SPEED_ROAD : PHYS.MAX_SPEED_GRASS) * cap;
  const drag = onRoad ? PHYS.DRAG_ROAD : PHYS.DRAG_GRASS;
  const grip = input.handbrake ? PHYS.GRIP_HANDBRAKE : (onRoad ? PHYS.GRIP_ROAD : PHYS.GRIP_GRASS);

  if (input.throttle > 0 && vF < maxSpeed) {
    vF += accel * input.throttle * dt;
  }
  if (input.brake > 0) {
    if (vF > 8) vF -= PHYS.BRAKE * input.brake * dt;
    else vF -= PHYS.REVERSE_ACCEL * input.brake * dt;
  }
  vF -= vF * drag * dt;
  if (vF > maxSpeed) vF = maxSpeed;
  if (vF < -PHYS.MAX_REVERSE) vF = -PHYS.MAX_REVERSE;

  vL *= Math.exp(-grip * dt);

  const speedFactor = Math.min(1, Math.abs(vF) / PHYS.TURN_SPEED_WINDOW);
  let omega = input.steer * PHYS.OMEGA_MAX * speedFactor;
  if (vF < 0) omega = -omega;
  if (input.handbrake) omega *= PHYS.HANDBRAKE_TURN_BOOST;
  car.angle += omega * dt;
  car.steer = input.steer;

  const cos2 = Math.cos(car.angle);
  const sin2 = Math.sin(car.angle);
  car.vx = cos2 * vF - sin2 * vL;
  car.vy = sin2 * vF + cos2 * vL;

  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.slip = Math.abs(vL);

  let hit = null;

  // Tyre stacks and signs
  for (const o of track.obstacles) {
    const dx = car.x - o.x;
    const dy = car.y - o.y;
    if (Math.abs(dx) > 90 || Math.abs(dy) > 90) continue;
    const d = Math.hypot(dx, dy);
    const min = o.r + PHYS.CAR_RADIUS;
    if (d < min && d > 0.0001) {
      const nx = dx / d;
      const ny = dy / d;
      car.x = o.x + nx * min;
      car.y = o.y + ny * min;
      const vn = car.vx * nx + car.vy * ny;
      if (vn < 0) {
        car.vx -= (1 + PHYS.RESTITUTION) * vn * nx;
        car.vy -= (1 + PHYS.RESTITUTION) * vn * ny;
        car.vx *= PHYS.HIT_SPEED_LOSS;
        car.vy *= PHYS.HIT_SPEED_LOSS;
        hit = 'obstacle';
      }
    }
  }

  // World bounds
  if (car.x < PHYS.WALL_BOUND) {
    car.x = PHYS.WALL_BOUND;
    if (car.vx < 0) {
      car.vx = -car.vx * PHYS.WALL_RESTITUTION;
      hit = 'wall';
    }
  } else if (car.x > WORLD.w - PHYS.WALL_BOUND) {
    car.x = WORLD.w - PHYS.WALL_BOUND;
    if (car.vx > 0) {
      car.vx = -car.vx * PHYS.WALL_RESTITUTION;
      hit = 'wall';
    }
  }
  if (car.y < PHYS.WALL_BOUND) {
    car.y = PHYS.WALL_BOUND;
    if (car.vy < 0) {
      car.vy = -car.vy * PHYS.WALL_RESTITUTION;
      hit = 'wall';
    }
  } else if (car.y > WORLD.h - PHYS.WALL_BOUND) {
    car.y = WORLD.h - PHYS.WALL_BOUND;
    if (car.vy > 0) {
      car.vy = -car.vy * PHYS.WALL_RESTITUTION;
      hit = 'wall';
    }
  }

  return hit;
}
