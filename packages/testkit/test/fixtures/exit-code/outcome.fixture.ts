import { expect, it } from 'vitest';

it('passes only when FIXTURE_SHOULD_PASS=1', () => {
  expect(process.env['FIXTURE_SHOULD_PASS']).toBe('1');
});
