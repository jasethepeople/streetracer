import { describe, expect, it } from 'vitest';
import {
  compileModScript,
  MAX_SCRIPT_SOURCE_CHARACTERS,
  ModScriptError,
  type ModScriptContext,
} from './mod-script';

const CONTEXT: ModScriptContext = {
  speedMetersPerSecond: 12,
  damageFraction: 0.25,
  distanceMeters: 1_500,
  elapsedSeconds: 95,
  completedMissions: 7,
  placeCategory: 'shop',
};

function run(source: string, context: Partial<ModScriptContext> = {}): number | string {
  return compileModScript(source)({ ...CONTEXT, ...context });
}

describe('compileModScript', () => {
  it('evaluates arithmetic and getters', () => {
    expect(run('(+ 1 2 3)')).toBe(6);
    expect(run('(* 2 (+ 1 3))')).toBe(8);
    expect(run('(- 10 4)')).toBe(6);
    expect(run('(/ 9 3)')).toBe(3);
    expect(run('(/ 5 0)')).toBe(Number.MAX_SAFE_INTEGER);
    expect(run('speed')).toBe(12);
    expect(run('damage')).toBe(0.25);
    expect(run('distance')).toBe(1_500);
    expect(run('elapsed')).toBe(95);
    expect(run('missions')).toBe(7);
    expect(run('place-category')).toBe('shop');
    expect(run('(distance)')).toBe(1_500);
    expect(run('(place-category)')).toBe('shop');
  });

  it('evaluates conditionals and boolean forms', () => {
    expect(run('(if (< speed 20) 1 0)')).toBe(1);
    expect(run('(if (> speed 20) 1)')).toBe(0);
    expect(run('(and 1 2 3)')).toBe(1);
    expect(run('(and 1 0 3)')).toBe(0);
    expect(run('(or 0 0 5)')).toBe(1);
    expect(run('(not 0)')).toBe(1);
    expect(run('(category-is "shop")')).toBe(1);
    expect(run('(category-is "park")')).toBe(0);
    expect(run('(if (category-is "shop") "yes" "no")')).toBe('yes');
  });

  it('supports min, max, clamp, abs, and floor', () => {
    expect(run('(min 3 1 2)')).toBe(1);
    expect(run('(max 3 1 2)')).toBe(3);
    expect(run('(clamp 9 0 5)')).toBe(5);
    expect(run('(clamp -4 0 5)')).toBe(0);
    expect(run('(abs (- 0 speed))')).toBe(12);
    expect(run('(floor (/ elapsed 60))')).toBe(1);
  });

  it('rejects scripts that are too long', () => {
    expect(() => compileModScript(`(+ 1 ${'+ 1'.repeat(400)})`)).toThrow(ModScriptError);
    expect(MAX_SCRIPT_SOURCE_CHARACTERS).toBe(512);
  });

  it('rejects unknown symbols, forms, and syntax errors', () => {
    expect(() => run('(fetch "http://example.com")')).toThrow(ModScriptError);
    expect(() => run('window')).toThrow(ModScriptError);
    expect(() => run('(+ 1')).toThrow(ModScriptError);
    expect(() => run('(+ 1 2))')).toThrow(ModScriptError);
    expect(() => run('()')).toThrow(ModScriptError);
    expect(() => run('(1 2)')).toThrow(ModScriptError);
    expect(() => run('"unterminated')).toThrow(ModScriptError);
    expect(() => run('(if)')).toThrow(ModScriptError);
    expect(() => run('(clamp 1 2)')).toThrow(ModScriptError);
    expect(() => run('(< "a" "b")')).toThrow(ModScriptError);
  });

  it('rejects deeply nested or oversized scripts', () => {
    const deep = '('.repeat(200) + 'speed' + ')'.repeat(200);
    expect(() => run(deep)).toThrow(ModScriptError);
    const wide = `(+ speed ${'speed '.repeat(40)})`;
    expect(() => run(wide)).toThrow(ModScriptError);
  });

  it('enforces the step budget across repeated evaluations', () => {
    const script = compileModScript('(+ speed speed)');
    expect(script(CONTEXT)).toBe(24);
    expect(script({ ...CONTEXT, speedMetersPerSecond: 30 })).toBe(60);
  });
});
