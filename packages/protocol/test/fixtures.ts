import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Side } from '../src/codec.js';
import { HTTP_REGISTRY, MESSAGE_REGISTRY } from '../src/generated/protocol.js';
import { FIXTURE_DIR } from '../src/schema-source.js';

/**
 * Fixture layout (the Go contract test reads the same files with the same rules):
 *   valid/<type>/<case>.json              must decode for every receiver of <type>
 *   invalid/<type>/<case>.<code>.json      decoded by the receiver of <type> ('both' -> server)
 *   invalid/_envelope|_json/...            receiver server
 *   invalid/_size/...                      receiver server, maxBytes = SIZE_FIXTURE_LIMIT
 *   invalid/_direction/...                 receiver = the side that SENDS the message's type
 * <type> is a WS message type or an HTTP body name (enroll.*).
 */
export const SIZE_FIXTURE_LIMIT = 1024;

export interface Fixture {
  readonly rel: string;
  readonly folder: string;
  readonly caseName: string;
  readonly bytes: Uint8Array;
  /** 'ok' for valid fixtures, otherwise the expected verdict code. */
  readonly expect: string;
}

function list(kind: 'valid' | 'invalid'): Fixture[] {
  const root = path.join(FIXTURE_DIR, kind);
  const out: Fixture[] = [];
  for (const folder of readdirSync(root).sort()) {
    for (const file of readdirSync(path.join(root, folder)).sort()) {
      if (!file.endsWith('.json')) continue;
      const stem = file.slice(0, -'.json'.length);
      const dot = stem.lastIndexOf('.');
      const caseName = kind === 'valid' ? stem : stem.slice(0, dot);
      const expect = kind === 'valid' ? 'ok' : stem.slice(dot + 1);
      out.push({
        rel: `${kind}/${folder}/${file}`,
        folder,
        caseName,
        bytes: readFileSync(path.join(root, folder, file)),
        expect,
      });
    }
  }
  return out;
}

export const validFixtures = (): Fixture[] => list('valid');
export const invalidFixtures = (): Fixture[] => list('invalid');

export const isMessageType = (t: string): t is keyof typeof MESSAGE_REGISTRY =>
  Object.hasOwn(MESSAGE_REGISTRY, t);
export const isHttpBody = (t: string): t is keyof typeof HTTP_REGISTRY =>
  Object.hasOwn(HTTP_REGISTRY, t);

const other = (s: Side): Side => (s === 'agent' ? 'server' : 'agent');

/** Receivers to decode an invalid fixture with, following the layout rules above. */
export function invalidReceiver(f: Fixture): { receiver: Side; maxBytes?: number } {
  if (f.folder === '_size') return { receiver: 'server', maxBytes: SIZE_FIXTURE_LIMIT };
  if (f.folder === '_envelope' || f.folder === '_json') return { receiver: 'server' };
  if (f.folder === '_direction') {
    const type = (JSON.parse(new TextDecoder().decode(f.bytes)) as { type: string }).type;
    if (!isMessageType(type)) throw new Error(`${f.rel}: unknown type`);
    const from = MESSAGE_REGISTRY[type].from as string;
    if (from === 'both') throw new Error(`${f.rel}: 'both' types have no wrong direction`);
    return { receiver: from as Side };
  }
  if (isMessageType(f.folder)) {
    const from = MESSAGE_REGISTRY[f.folder].from as string;
    return { receiver: from === 'both' ? 'server' : other(from as Side) };
  }
  if (isHttpBody(f.folder)) return { receiver: 'server' };
  throw new Error(`${f.rel}: unknown fixture folder`);
}
