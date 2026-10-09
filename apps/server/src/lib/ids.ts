import { randomBytes } from 'node:crypto';

import { uuidV7 } from '@binjari/shared';

import type { Clock } from './clock.js';

/** Source of new UUIDv7 ids: time from the injected Clock, randomness injectable for tests. */
export interface Ids {
  newId(): string;
}

export type RandomBytesFn = (n: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytesFn = (n) => randomBytes(n);

export function createIds(clock: Clock, random: RandomBytesFn = cryptoRandomBytes): Ids {
  return { newId: () => uuidV7(clock.now().getTime(), random(10)) };
}
