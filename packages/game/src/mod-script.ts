/**
 * ModScript: a tiny sandboxed Lisp-style expression language for mission mods.
 *
 * Design goals (see docs/MODDING.md):
 * - Hard isolation by construction: scripts evaluate numbers and strings through a
 *   fixed interpreter. There are no functions values, no loops, no property access,
 *   no globals, and no host objects reachable from script code.
 * - Deterministic and terminating: step and depth caps guarantee evaluation ends.
 * - Identical behavior in the browser and on the server (pure TypeScript).
 *
 * Grammar (S-expressions over plain text):
 *   number   42  -3.5
 *   string   "shop"
 *   symbol   speed | damage | distance | elapsed | missions | place-category
 *   forms    (if cond then else)
 *            (and expr...) (or expr...) (not expr)
 *            (= a b) (!= a b) (< a b) (<= a b) (> a b) (>= a b)
 *            (+ a ...) (- a ...) (* a ...) (/ a ...)
 *            (min a b) (max a b) (clamp x lo hi) (abs x) (floor x)
 *            (category-is "shop")
 *
 * Scripts return a number (or a string for `place-category` passthrough styles),
 * which the caller clamps to the hook's allowed range before use.
 */

export interface ModScriptContext {
  readonly speedMetersPerSecond: number;
  readonly damageFraction: number;
  readonly distanceMeters: number;
  readonly elapsedSeconds: number;
  readonly completedMissions: number;
  readonly placeCategory: string;
}

export type ModScript = (context: ModScriptContext) => number | string;

export const MAX_SCRIPT_SOURCE_CHARACTERS = 512;
const MAX_STEPS = 4_000;
const MAX_DEPTH = 48;
const MAX_LIST_ELEMENTS = 16;

type Value = number | string;

type Node =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'symbol'; readonly name: string }
  | { readonly kind: 'list'; readonly elements: readonly Node[] };

export class ModScriptError extends Error {}

const GETTERS: ReadonlySet<string> = new Set([
  'speed',
  'damage',
  'distance',
  'elapsed',
  'missions',
  'place-category',
]);

const ZERO_ARGUMENTS: readonly [number, number] = [0, 0];
const SYMBOL_NAMES: ReadonlySet<string> = new Set([
  ...GETTERS,
  'if',
  'and',
  'or',
  'not',
  'category-is',
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  'min',
  'max',
  'clamp',
  'abs',
  'floor',
]);

export function compileModScript(source: string): ModScript {
  if (typeof source !== 'string' || source.length === 0) {
    throw new ModScriptError('Script source is empty.');
  }
  if (source.length > MAX_SCRIPT_SOURCE_CHARACTERS) {
    throw new ModScriptError(`Script source exceeds ${MAX_SCRIPT_SOURCE_CHARACTERS} characters.`);
  }
  const tokens = tokenize(source);
  const reader = new Reader(tokens);
  const program = reader.readNode(0);
  if (!reader.atEnd()) throw new ModScriptError('Unexpected content after the expression.');
  validateNode(program, 0);
  const state = { steps: 0 };
  return (context: ModScriptContext): number | string => {
    state.steps = 0;
    const result = evaluate(program, context, state, 0);
    if (typeof result !== 'number' && typeof result !== 'string') {
      throw new ModScriptError('Script produced an unsupported value.');
    }
    return result;
  };
}

function tokenize(source: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === ';' && source.startsWith(';', index)) {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '(' || character === ')') {
      tokens.push(character);
      index += 1;
      continue;
    }
    if (character === '"') {
      const end = source.indexOf('"', index + 1);
      if (end < 0) throw new ModScriptError('String literal is missing its closing quote.');
      tokens.push(source.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const match = /^[^()\s";]+/u.exec(source.slice(index));
    if (!match) throw new ModScriptError(`Unexpected character '${character}'.`);
    tokens.push(match[0]);
    index += match[0].length;
    if (tokens.length > 512) throw new ModScriptError('Script has too many tokens.');
  }
  return tokens;
}

class Reader {
  private index = 0;

  constructor(private readonly tokens: readonly string[]) {}

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  readNode(depth: number): Node {
    if (depth > MAX_DEPTH) throw new ModScriptError('Expression nests too deeply.');
    const token = this.tokens[this.index];
    if (token === undefined) throw new ModScriptError('Expression ends unexpectedly.');
    this.index += 1;
    if (token === '(') {
      const elements: Node[] = [];
      while (true) {
        if (this.atEnd()) throw new ModScriptError('List is missing its closing parenthesis.');
        if (this.tokens[this.index] === ')') {
          this.index += 1;
          break;
        }
        if (elements.length >= MAX_LIST_ELEMENTS) {
          throw new ModScriptError(`Lists accept at most ${MAX_LIST_ELEMENTS} elements.`);
        }
        elements.push(this.readNode(depth + 1));
      }
      return { kind: 'list', elements };
    }
    if (token === ')') throw new ModScriptError('Unexpected closing parenthesis.');
    if (token.startsWith('"')) {
      return { kind: 'string', value: token.slice(1, -1) };
    }
    if (/^[+-]?[0-9]+(\.[0-9]+)?$/u.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new ModScriptError(`Invalid number '${token}'.`);
      return { kind: 'number', value };
    }
    if (!/^[a-z0-9=!<>*/+-]+$/u.test(token) || !SYMBOL_NAMES.has(token)) {
      throw new ModScriptError(`Unknown symbol '${token}'.`);
    }
    return { kind: 'symbol', name: token };
  }
}

function validateNode(node: Node, depth: number): void {
  if (depth > MAX_DEPTH) throw new ModScriptError('Expression nests too deeply.');
  if (node.kind !== 'list') return;
  const head = node.elements[0];
  if (head === undefined) throw new ModScriptError('Empty list is not allowed.');
  if (head.kind !== 'symbol') throw new ModScriptError('Lists must start with a known form.');
  const arity = ARITY[head.name] ?? (GETTERS.has(head.name) ? ZERO_ARGUMENTS : undefined);
  if (arity === undefined) throw new ModScriptError(`Unknown form '${head.name}'.`);
  const [minimum, maximum] = arity;
  const count = node.elements.length - 1;
  if (count < minimum || (maximum !== -1 && count > maximum)) {
    throw new ModScriptError(`Form '${head.name}' takes ${describeArity(minimum, maximum)}.`);
  }
  for (const element of node.elements.slice(1)) validateNode(element, depth + 1);
}

const ARITY: Readonly<Record<string, readonly [number, number]>> = {
  if: [2, 3],
  and: [1, -1],
  or: [1, -1],
  not: [1, 1],
  '=': [2, 2],
  '!=': [2, 2],
  '<': [2, 2],
  '<=': [2, 2],
  '>': [2, 2],
  '>=': [2, 2],
  '+': [1, -1],
  '-': [1, -1],
  '*': [1, -1],
  '/': [2, 2],
  min: [2, -1],
  max: [2, -1],
  clamp: [3, 3],
  abs: [1, 1],
  floor: [1, 1],
  'category-is': [1, 1],
};

function describeArity(minimum: number, maximum: number): string {
  if (maximum === -1)
    return minimum === 1 ? 'at least 1 argument' : `at least ${minimum} arguments`;
  if (minimum === maximum) return minimum === 1 ? 'exactly 1 argument' : `${minimum} arguments`;
  return `${minimum} to ${maximum} arguments`;
}

interface EvalState {
  steps: number;
}

function evaluate(node: Node, context: ModScriptContext, state: EvalState, depth: number): Value {
  if (depth > MAX_DEPTH) throw new ModScriptError('Expression nests too deeply.');
  state.steps += 1;
  if (state.steps > MAX_STEPS) throw new ModScriptError('Script exceeded its step budget.');
  if (node.kind === 'number') return node.value;
  if (node.kind === 'string') return node.value;
  if (node.kind === 'symbol') return readGetter(node.name, context);
  const head = node.elements[0]!;
  if (head.kind !== 'symbol') throw new ModScriptError('Lists must start with a form name.');
  const name = head.name;
  if (GETTERS.has(name) && node.elements.length === 1) return readGetter(name, context);
  switch (name) {
    case 'if': {
      const condition = evaluate(node.elements[1]!, context, state, depth + 1);
      if (isConditionTrue(condition)) {
        return evaluate(node.elements[2]!, context, state, depth + 1);
      }
      const fallback = node.elements[3];
      return fallback ? evaluate(fallback, context, state, depth + 1) : 0;
    }
    case 'and': {
      for (const element of node.elements.slice(1)) {
        if (!isConditionTrue(evaluate(element, context, state, depth + 1))) return 0;
      }
      return 1;
    }
    case 'or': {
      for (const element of node.elements.slice(1)) {
        if (isConditionTrue(evaluate(element, context, state, depth + 1))) return 1;
      }
      return 0;
    }
    case 'not':
      return isConditionTrue(evaluate(node.elements[1]!, context, state, depth + 1)) ? 0 : 1;
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const left = evaluate(node.elements[1]!, context, state, depth + 1);
      const right = evaluate(node.elements[2]!, context, state, depth + 1);
      if (typeof left !== 'number' || typeof right !== 'number') {
        if (name === '=' || name === '!=') {
          const equal = left === right;
          return (name === '=' ? equal : !equal) ? 1 : 0;
        }
        throw new ModScriptError(`'${name}' compares numbers only.`);
      }
      return compareNumbers(name, left, right) ? 1 : 0;
    }
    case '+':
    case '-':
    case '*':
    case '/':
    case 'min':
    case 'max': {
      const values = node.elements.slice(1).map((element) => {
        const value = evaluate(element, context, state, depth + 1);
        if (typeof value !== 'number') throw new ModScriptError(`'${name}' needs numbers.`);
        return value;
      });
      return applyArithmetic(name, values);
    }
    case 'clamp': {
      const [value, low, high] = node.elements.slice(1).map((element) => {
        const candidate = evaluate(element, context, state, depth + 1);
        if (typeof candidate !== 'number') throw new ModScriptError("'clamp' needs numbers.");
        return candidate;
      });
      return Math.min(Math.max(value!, low!), high!);
    }
    case 'abs': {
      const value = evaluate(node.elements[1]!, context, state, depth + 1);
      if (typeof value !== 'number') throw new ModScriptError("'abs' needs a number.");
      return Math.abs(value);
    }
    case 'floor': {
      const value = evaluate(node.elements[1]!, context, state, depth + 1);
      if (typeof value !== 'number') throw new ModScriptError("'floor' needs a number.");
      return Math.floor(value);
    }
    case 'category-is': {
      const value = evaluate(node.elements[1]!, context, state, depth + 1);
      if (typeof value !== 'string') throw new ModScriptError("'category-is' needs a string.");
      return value === context.placeCategory ? 1 : 0;
    }
    default:
      return readGetter(name, context);
  }
}

function readGetter(name: string, context: ModScriptContext): Value {
  switch (name) {
    case 'speed':
      return context.speedMetersPerSecond;
    case 'damage':
      return context.damageFraction;
    case 'distance':
      return context.distanceMeters;
    case 'elapsed':
      return context.elapsedSeconds;
    case 'missions':
      return context.completedMissions;
    case 'place-category':
      return context.placeCategory;
    default:
      throw new ModScriptError(`Unknown form '${name}'.`);
  }
}

function isConditionTrue(value: Value): boolean {
  return typeof value === 'number' ? value !== 0 : value.length > 0;
}

function compareNumbers(name: string, left: number, right: number): boolean {
  switch (name) {
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      throw new ModScriptError(`Unknown comparison '${name}'.`);
  }
}

function applyArithmetic(name: string, values: readonly number[]): number {
  if (name === 'min') return Math.min(...values);
  if (name === 'max') return Math.max(...values);
  if (name === '+') return values.reduce((total, value) => total + value, 0);
  if (name === '*') return values.reduce((total, value) => total * value, 1);
  if (name === '-') return values.length === 1 ? -values[0]! : values.reduce((a, b) => a - b);
  const divisor = values[1]!;
  if (divisor === 0) return values[0]! > 0 ? Number.MAX_SAFE_INTEGER : 0;
  return values[0]! / divisor;
}
