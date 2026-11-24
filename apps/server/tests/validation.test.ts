import { describe, expect, it } from 'vitest';
import { MAX_CHAT_CHARACTERS, MAX_FORWARD_SPEED_MPS } from '@openstreet-racer/shared';
import { localMetersToLonLat, lonLatToLocalMeters } from '@openstreet-racer/world';
import {
  limitTeleportDistance,
  parseClientMessage,
  sanitizeChatText,
  sanitizeHandle,
} from '../src/validation';

describe('client message validation', () => {
  it('requires a supported version and valid JSON object', () => {
    expect(parseClientMessage('{')).toMatchObject({ ok: false, code: 'INVALID_JSON' });
    expect(parseClientMessage('[]')).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    expect(parseClientMessage('{"version":99,"type":"ping","clientTimeMs":1}')).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_VERSION',
    });
  });

  it('validates the initial car state and canonicalizes bounded values', () => {
    const result = parseClientMessage(
      JSON.stringify({
        version: 1,
        type: 'hello',
        handle: '  Alice 🌎 <script> ',
        car: {
          position: { longitude: -104.99, latitude: 90 },
          altitudeMeters: 500,
          velocity: { eastMetersPerSecond: 30, northMetersPerSecond: 30, upMetersPerSecond: 50 },
          headingRadians: -Math.PI / 2,
          speedMetersPerSecond: 200,
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.message.type !== 'hello') return;
    expect(result.message.handle).toBe('Alice script');
    expect(result.message.car.position.latitude).toBe(85.05113);
    expect(result.message.car.altitudeMeters).toBe(200);
    expect(
      Math.hypot(
        result.message.car.velocity.eastMetersPerSecond,
        result.message.car.velocity.northMetersPerSecond,
      ),
    ).toBeCloseTo(36);
    expect(result.message.car.velocity.upMetersPerSecond).toBe(12);
    expect(result.message.car.headingRadians).toBeCloseTo((3 * Math.PI) / 2);
    expect(result.message.car.speedMetersPerSecond).toBe(MAX_FORWARD_SPEED_MPS);
  });

  it('rejects non-finite, out-of-range, or missing state fields', () => {
    const invalid = JSON.stringify({
      version: 1,
      type: 'state',
      seq: 1,
      car: { ...validCar(), speedMetersPerSecond: Number.NaN },
    });
    expect(parseClientMessage(invalid)).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(
      parseClientMessage(JSON.stringify({ version: 1, type: 'state', seq: -1, car: validCar() })),
    ).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('strips control characters and caps safe chat text by Unicode code point', () => {
    const text = sanitizeChatText(`  hello\n world ${'🙂'.repeat(MAX_CHAT_CHARACTERS + 5)} `);
    expect(text.startsWith('hello world')).toBe(true);
    expect(Array.from(text)).toHaveLength(MAX_CHAT_CHARACTERS);
    expect(sanitizeChatText(' \u0000\u0007 ')).toBe('');
  });

  it('limits handles without splitting a Unicode character', () => {
    expect(sanitizeHandle('  Ada\n Lovelace! 🙂 ')).toBe('Ada Lovelace');
    expect(Array.from(sanitizeHandle('🙂'.repeat(40))).length).toBe(0);
  });

  it('bounds position changes according to elapsed server time', () => {
    const previous = validCar();
    const nextPosition = localMetersToLonLat({ x: 1_000, y: 0 }, previous.position);
    const limited = limitTeleportDistance({ ...previous, position: nextPosition }, previous, 0.1);
    const displacement = lonLatToLocalMeters(limited.position, previous.position);
    expect(Math.hypot(displacement.x, displacement.y)).toBeCloseTo(8.4, 1);
    expect(
      Math.hypot(
        ...Object.values(limited.velocity)
          .slice(0, 2)
          .map((value) => Number(value)),
      ),
    ).toBeLessThanOrEqual(36);
  });
});

function validCar() {
  return {
    position: { longitude: -104.99, latitude: 39.74 },
    altitudeMeters: 0.6,
    velocity: { eastMetersPerSecond: 0, northMetersPerSecond: 0, upMetersPerSecond: 0 },
    headingRadians: 0,
    speedMetersPerSecond: 0,
  };
}
