import { expect, test } from 'vitest';
import { VERSION } from '../src/index';

test('exposes a version', () => {
  expect(VERSION).toBe('0.0.0');
});
