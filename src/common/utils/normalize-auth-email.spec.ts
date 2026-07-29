import { describe, expect, it } from '@jest/globals';

import { normalizeAuthEmail } from './normalize-auth-email';

describe('normalizeAuthEmail', () => {
  it('trims and lowercases email', () => {
    expect(normalizeAuthEmail(' USER@EXAMPLE.COM ')).toBe('user@example.com');
  });

  it('rejects non-string values', () => {
    expect(() => normalizeAuthEmail(undefined)).toThrow(TypeError);
  });

  it('normalizes whitespace-only input to empty', () => {
    expect(normalizeAuthEmail('   ')).toBe('');
  });
});
