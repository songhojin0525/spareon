/**
 * Turns the schema bundle into a small, language-neutral type model that both the TS and the Go emitters
 * render. Only the schema subset allowed by schema-lint.ts exists here; anything else is a generator bug
 * and throws.
 */
import type { ProtocolBundle } from '../bundle.js';

export type TypeIR =
  | { readonly k: 'string' }
  | { readonly k: 'integer' }
  | { readonly k: 'boolean' }
  | { readonly k: 'literal'; readonly value: string | number }
  | { readonly k: 'array'; readonly items: TypeIR }
  | { readonly k: 'named'; readonly name: string };

export interface FieldIR {
  readonly json: string;
  readonly type: TypeIR;
  readonly required: boolean;
}

export type NamedIR =
  | { readonly k: 'object'; readonly name: string; readonly fields: readonly FieldIR[] }
  | { readonly k: 'enum'; readonly name: string; readonly values: readonly string[] };

export interface MessageIR {
  readonly type: string;
  readonly from: 'agent' | 'server' | 'both';
  readonly corr: 'required' | 'optional' | 'forbidden';
  readonly replies: readonly string[];
  readonly timeoutMs: number | null;
  readonly payload: string; // named object type
}

export interface HttpIR {
  readonly name: string;
  readonly from: 'agent' | 'server';
  readonly method: string;
  readonly path: string;
  readonly replies: readonly string[];
  readonly body: string; // named object type
}

export interface ErrorCodeIR {
  readonly code: string;
  readonly from: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
  readonly agentAction: string;
  readonly meaning: string;
}

export interface ProtocolIR {
  readonly named: ReadonlyMap<string, NamedIR>;
  readonly messages: readonly MessageIR[];
  readonly http: readonly HttpIR[];
  readonly manifests: readonly { readonly kind: string; readonly type: string }[];
  readonly errorCodes: readonly ErrorCodeIR[];
  readonly limits: readonly { readonly name: string; readonly value: number }[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const INITIALISMS: Record<string, string> = {
  id: 'ID',
  ids: 'IDs',
  url: 'URL',
  cpu: 'CPU',
  gpu: 'GPU',
  gpus: 'GPUs',
  ram: 'RAM',
  os: 'OS',
  uuid: 'UUID',
  ttl: 'TTL',
  http: 'HTTP',
  json: 'JSON',
  vram: 'VRAM',
};

/** PascalCase with Go-style initialisms: "job.offer" -> JobOffer, "attemptId" -> AttemptID. */
export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter((w) => w.length > 0)
    .map((w) => {
      const lower = w.toLowerCase();
      return INITIALISMS[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

const singular = (field: string): string =>
  field.endsWith('s') && !field.endsWith('ss') ? field.slice(0, -1) : field;

export function buildIR(bundle: ProtocolBundle): ProtocolIR {
  const files = bundle.files;
  const named = new Map<string, NamedIR>();
  const refNames = new Map<string, string>(); // "file#pointer" -> named type

  const resolvePointer = (file: string, pointer: string): unknown => {
    let node: unknown = files[file];
    if (node === undefined) throw new Error(`unknown file ${file}`);
    for (const seg of pointer.split('/').filter((s) => s !== '')) {
      if (!isObj(node)) throw new Error(`bad pointer ${file}#${pointer}`);
      node = node[seg];
    }
    if (node === undefined) throw new Error(`bad pointer ${file}#${pointer}`);
    return node;
  };

  const resolveRef = (fromFile: string, ref: string): { file: string; pointer: string } => {
    const [target = '', pointer = ''] = ref.split('#');
    if (target === '') return { file: fromFile, pointer };
    const base = fromFile.split('/').slice(0, -1);
    for (const seg of target.split('/')) {
      if (seg === '..') base.pop();
      else if (seg !== '.') base.push(seg);
    }
    return { file: base.join('/'), pointer };
  };

  const register = (n: NamedIR): void => {
    const prev = named.get(n.name);
    if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(n)) {
      throw new Error(`named type collision: ${n.name}`);
    }
    named.set(n.name, n);
  };

  const nameForRef = (file: string, pointer: string): string => {
    const def = /^\/\$defs\/([A-Za-z0-9]+)$/.exec(pointer);
    if (def?.[1] !== undefined) return pascal(def[1]);
    if (pointer === '') {
      const stem =
        file
          .split('/')
          .pop()
          ?.replace(/\.json$/, '') ?? file;
      if (file.startsWith('manifests/')) return `${pascal(stem)}Manifest`;
      return pascal(stem);
    }
    throw new Error(`cannot name ${file}#${pointer}`);
  };

  const typeOf = (file: string, node: unknown, ctx: string): TypeIR => {
    if (!isObj(node)) throw new Error(`${ctx}: schema must be an object`);
    if (typeof node['$ref'] === 'string') {
      const { file: f, pointer } = resolveRef(file, node['$ref']);
      const key = `${f}#${pointer}`;
      const target = resolvePointer(f, pointer);
      if (!isObj(target)) throw new Error(`${ctx}: bad ref target`);
      const isNamed =
        target['type'] === 'object' || Array.isArray(target['enum']) || '$ref' in target;
      if (!isNamed) return typeOf(f, target, ctx);
      if ('$ref' in target && target['type'] === undefined && !Array.isArray(target['enum'])) {
        return typeOf(f, target, ctx); // alias of an alias
      }
      let name = refNames.get(key);
      if (name === undefined) {
        name = nameForRef(f, pointer);
        refNames.set(key, name);
        const t = typeOf(f, target, name);
        if (t.k !== 'named' || t.name !== name) throw new Error(`${ctx}: unexpected ref shape`);
      }
      return { k: 'named', name };
    }
    if ('const' in node) {
      const v = node['const'];
      if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`${ctx}: bad const`);
      return { k: 'literal', value: v };
    }
    if (Array.isArray(node['enum'])) {
      const values = node['enum'] as unknown[];
      if (!values.every((v): v is string => typeof v === 'string')) {
        throw new Error(`${ctx}: only string enums are supported`);
      }
      register({ k: 'enum', name: ctx, values });
      return { k: 'named', name: ctx };
    }
    switch (node['type']) {
      case 'string':
        return { k: 'string' };
      case 'integer':
        return { k: 'integer' };
      case 'boolean':
        return { k: 'boolean' };
      case 'array':
        return { k: 'array', items: typeOf(file, node['items'], ctx) };
      case 'object': {
        const props = isObj(node['properties']) ? node['properties'] : {};
        const required = new Set(
          Array.isArray(node['required']) ? (node['required'] as string[]) : [],
        );
        const prefix = ctx.replace(/Payload$/, '');
        const fields: FieldIR[] = Object.entries(props).map(([json, sub]) => {
          const childCtx =
            isObj(sub) && sub['type'] === 'array'
              ? prefix + pascal(singular(json))
              : prefix + pascal(json);
          return { json, type: typeOf(file, sub, childCtx), required: required.has(json) };
        });
        register({ k: 'object', name: ctx, fields });
        return { k: 'named', name: ctx };
      }
      default:
        throw new Error(`${ctx}: unsupported schema`);
    }
  };

  const registry = files['registry.json'] as {
    messages: Record<string, { from: MessageIR['from']; replies: string[]; timeoutMs?: number }>;
    http: Record<string, { from: HttpIR['from']; method: string; path: string; replies: string[] }>;
  };

  const messages: MessageIR[] = Object.entries(registry.messages)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, info]) => {
      const file = `messages/${type}.json`;
      const doc = files[file];
      if (!isObj(doc) || !isObj(doc['properties'])) throw new Error(`${file}: bad message schema`);
      const payloadType = typeOf(file, doc['properties']['payload'], `${pascal(type)}Payload`);
      if (payloadType.k !== 'named') throw new Error(`${file}: payload must be an object`);
      const req = Array.isArray(doc['required']) ? (doc['required'] as string[]) : [];
      const forbidden =
        isObj(doc['not']) &&
        Array.isArray(doc['not']['required']) &&
        (doc['not']['required'] as string[]).includes('corr');
      return {
        type,
        from: info.from,
        corr: req.includes('corr') ? 'required' : forbidden ? 'forbidden' : 'optional',
        replies: info.replies,
        timeoutMs: info.timeoutMs ?? null,
        payload: payloadType.name,
      };
    });

  const http: HttpIR[] = Object.entries(registry.http)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, info]) => {
      const t = typeOf(`http/${name}.json`, files[`http/${name}.json`], pascal(name));
      if (t.k !== 'named') throw new Error(`http/${name}.json: body must be an object`);
      return { name, ...info, body: t.name };
    });

  const manifests = Object.keys(files)
    .filter((f) => f.startsWith('manifests/'))
    .sort()
    .map((f) => {
      const kind = f.slice('manifests/'.length, -'.json'.length);
      const t = typeOf(f, { $ref: `../${f}` }, '');
      if (t.k !== 'named') throw new Error(`${f}: manifest must be an object`);
      return { kind, type: t.name };
    });

  // Shared defs that no message happens to reference still get types (policy, job input, ...).
  for (const f of Object.keys(files).filter((x) => x.startsWith('defs/'))) {
    const doc = files[f];
    if (!isObj(doc) || typeof doc['$schema'] !== 'string') continue;
    if (doc['type'] === 'object') typeOf(f, { $ref: `../${f}` }, '');
    if (isObj(doc['$defs'])) {
      for (const [defName, def] of Object.entries(doc['$defs'])) {
        if (isObj(def) && (def['type'] === 'object' || Array.isArray(def['enum']))) {
          typeOf(f, { $ref: `#/$defs/${defName}` }, '');
        }
      }
    }
  }

  const errorDoc = files['defs/error-codes.json'] as {
    codes: Record<string, Omit<ErrorCodeIR, 'code'>>;
  };
  const errorCodes = Object.entries(errorDoc.codes).map(([code, e]) => ({ code, ...e }));
  const limits = Object.entries(files['limits.json'] as Record<string, number>).map(
    ([name, value]) => ({ name, value }),
  );

  return { named, messages, http, manifests, errorCodes, limits };
}
