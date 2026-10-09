/**
 * Rules every protocol schema must follow (PROTOCOL.md "스키마 작성 규칙"). The generator refuses to run when
 * any rule fails, so an unbounded string, an unbounded array or a float can never reach either language.
 *
 * 1. Only whitelisted keywords. No `format`, no human text (`title`, `description`, `examples`, `default`).
 * 2. `type` is one of object, array, string, integer, boolean. No `number` (integers only), no `null`.
 * 3. Strings have `maxLength` unless fixed by `enum`/`const`; patterns are ASCII and anchored ^...$.
 * 4. Arrays have `items` and `maxItems`; optional arrays have `minItems >= 1` (lossless Go omitempty).
 * 5. Integers have `minimum` and `maximum` (or `const`/`enum`) inside ±(2^53 − 1).
 * 6. Objects have `additionalProperties: false` (the envelope's open `payload` is the single exception;
 *    every message schema closes it) and `required` names only declared properties.
 * 7. Combinators (`oneOf`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`) only add constraints on properties
 *    the parent object declares: they may use `required`, `const`, `enum`, `properties`, and nest.
 */

const MAX_SAFE = 2 ** 53 - 1;
/** Largest maxLength/maxItems: the biggest thing the protocol carries (maxInputRefBytes, 16 MiB). */
const MAX_SIZE = 16 * 1024 * 1024;

/** True when `|` appears outside any group or character class, e.g. `^a|b$`. */
function hasTopLevelAlternation(pattern: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      i++;
    } else if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (c === '|' && depth === 0) {
      return true;
    }
  }
  return false;
}

const SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
  'const',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
]);
const COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else'] as const;
const CONSTRAINT_KEYWORDS = new Set([
  'required',
  'const',
  'enum',
  'properties',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
]);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'boolean']);
/** JSON pointers (file#path) allowed to be open objects. */
const OPEN_OBJECTS = new Set(['envelope.json#/properties/payload']);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

export function isSchemaFile(doc: unknown): boolean {
  return isObj(doc) && typeof doc['$schema'] === 'string';
}

/** Returns human-readable rule violations for one schema file (empty array = clean). */
export function lintSchema(file: string, doc: unknown): string[] {
  const problems: string[] = [];
  const report = (at: string, msg: string): void => {
    problems.push(`${file}#${at}: ${msg}`);
  };

  const visit = (node: unknown, at: string, optionalInParent: boolean): void => {
    if (!isObj(node)) {
      report(at, 'schema must be an object');
      return;
    }
    for (const k of Object.keys(node)) {
      if (!SCHEMA_KEYWORDS.has(k)) report(at, `keyword "${k}" is not allowed`);
    }
    const type = node['type'];
    const hasRef = typeof node['$ref'] === 'string';
    const fixed = 'const' in node || 'enum' in node;
    if (type !== undefined && (typeof type !== 'string' || !TYPES.has(type))) {
      report(at, `type must be one of ${[...TYPES].join(', ')}`);
    }
    if (type === undefined && !hasRef && !fixed && at !== '') {
      report(at, 'schema needs a type, $ref, const or enum');
    }
    for (const value of [
      ...(Array.isArray(node['enum']) ? (node['enum'] as unknown[]) : []),
      ...('const' in node ? [node['const']] : []),
    ]) {
      if (typeof value === 'string' && !isAscii(value)) report(at, 'enum/const must be ASCII');
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        report(at, 'numeric const/enum must be a safe integer');
      }
    }
    if (typeof node['pattern'] === 'string') {
      const p = node['pattern'];
      if (!isAscii(p) || !p.startsWith('^') || !p.endsWith('$') || p.endsWith('\\$')) {
        report(at, 'pattern must be ASCII and anchored with ^...$');
      }
      if (hasTopLevelAlternation(p)) {
        report(at, 'pattern must not alternate at the top level (^a|b$ anchors only one side)');
      }
    }
    for (const key of ['maxLength', 'maxItems'] as const) {
      const n = node[key];
      if (typeof n === 'number' && (!Number.isSafeInteger(n) || n < 0 || n > MAX_SIZE)) {
        report(at, `${key} must be an integer in 0..${String(MAX_SIZE)}`);
      }
    }

    if (type === 'string' && !fixed && typeof node['maxLength'] !== 'number') {
      report(at, 'string needs maxLength');
    }
    if (type === 'array') {
      if (typeof node['maxItems'] !== 'number') report(at, 'array needs maxItems');
      if (node['items'] === undefined) report(at, 'array needs items');
      if (optionalInParent && !(typeof node['minItems'] === 'number' && node['minItems'] >= 1)) {
        report(at, 'optional array needs minItems >= 1');
      }
    }
    if (type === 'integer' && !fixed) {
      const min = node['minimum'];
      const max = node['maximum'];
      if (typeof min !== 'number' || typeof max !== 'number') {
        report(at, 'integer needs minimum and maximum');
      } else if (Math.abs(min) > MAX_SAFE || Math.abs(max) > MAX_SAFE || min > max) {
        report(at, 'integer bounds must be within ±(2^53 - 1) and ordered');
      }
    }
    const props = isObj(node['properties']) ? node['properties'] : undefined;
    const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : [];
    if (type === 'object') {
      if (node['additionalProperties'] !== false && !OPEN_OBJECTS.has(`${file}#${at}`)) {
        report(at, 'object needs additionalProperties: false');
      }
      for (const r of required) {
        if (typeof r !== 'string' || props?.[r] === undefined) {
          report(at, `required "${String(r)}" is not a declared property`);
        }
      }
    }
    if (props !== undefined) {
      for (const [name, sub] of Object.entries(props)) {
        visit(sub, `${at}/properties/${name}`, !required.includes(name));
      }
    }
    if (node['items'] !== undefined) visit(node['items'], `${at}/items`, false);
    if (isObj(node['$defs'])) {
      for (const [name, sub] of Object.entries(node['$defs'])) {
        visit(sub, `${at}/$defs/${name}`, false);
      }
    }
    // With $ref the full property set lives in the referenced schema, so names cannot be checked here.
    const declared = hasRef ? null : new Set(props === undefined ? [] : Object.keys(props));
    for (const c of COMBINATORS) {
      const v = node[c];
      if (v === undefined) continue;
      const subs = Array.isArray(v) ? (v as unknown[]) : [v];
      subs.forEach((s, i) => {
        visitConstraint(s, `${at}/${c}${Array.isArray(v) ? `/${i}` : ''}`, declared);
      });
    }
  };

  const visitConstraint = (node: unknown, at: string, declared: Set<string> | null): void => {
    if (!isObj(node)) {
      report(at, 'constraint must be an object');
      return;
    }
    for (const k of Object.keys(node)) {
      if (!CONSTRAINT_KEYWORDS.has(k)) report(at, `keyword "${k}" is not allowed in a constraint`);
    }
    const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : [];
    for (const r of required) {
      if (typeof r !== 'string' || (declared !== null && !declared.has(r))) {
        report(at, `constraint requires undeclared property "${String(r)}"`);
      }
    }
    if (isObj(node['properties'])) {
      for (const [name, sub] of Object.entries(node['properties'])) {
        if (declared !== null && !declared.has(name))
          report(at, `constraint names undeclared property "${name}"`);
        // Nested constraints apply to the property's own (object) value; its declared names are unknown
        // here, so only the keyword whitelist is enforced below that level.
        visitConstraint(sub, `${at}/properties/${name}`, null);
      }
    }
    for (const c of COMBINATORS) {
      const v = node[c];
      if (v === undefined) continue;
      const subs = Array.isArray(v) ? (v as unknown[]) : [v];
      subs.forEach((s, i) => {
        visitConstraint(s, `${at}/${c}${Array.isArray(v) ? `/${i}` : ''}`, declared);
      });
    }
  };

  visit(doc, '', false);
  return problems;
}
