import { describe, expect, it } from '@jest/globals';
import { maskAccessSupportContactEmail } from './mask-access-support-contact.util';

describe('maskAccessSupportContactEmail', () => {
  it('normalizes and masks without disclosing component lengths', () => {
    expect(maskAccessSupportContactEmail(' Person@Example.COM ')).toBe(
      'p***@e***.com',
    );
    expect(maskAccessSupportContactEmail('p@example.com')).toBe(
      'p***@e***.com',
    );
  });

  it('masks every domain label except the top-level domain', () => {
    expect(maskAccessSupportContactEmail('user@mail.eu.example.com')).toBe(
      'u***@m***.e***.e***.com',
    );
  });

  it.each(['', 'person', '@example.com', 'person@example', 'person@.com'])(
    'rejects malformed contact %p',
    (value) => {
      expect(() => maskAccessSupportContactEmail(value)).toThrow(
        'Access-support contact không hợp lệ',
      );
    },
  );
});
