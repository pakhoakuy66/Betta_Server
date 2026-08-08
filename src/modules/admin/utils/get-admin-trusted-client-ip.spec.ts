import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import {
  getAdminTrustedClientIp,
  normalizeAdminTrustedClientIp,
} from './get-admin-trusted-client-ip';

describe('getAdminTrustedClientIp', () => {
  it('uses Express request.ip instead of parsing forwarding headers itself', () => {
    expect(
      getAdminTrustedClientIp({
        ip: '203.0.113.10',
        socket: { remoteAddress: '10.0.0.4' },
      }),
    ).toBe('203.0.113.10');
  });

  it('falls back to the socket address when Express has no request.ip', () => {
    expect(
      getAdminTrustedClientIp({
        socket: { remoteAddress: '198.51.100.9' },
      }),
    ).toBe('198.51.100.9');
  });

  it('normalizes IPv4-mapped and equivalent IPv6 forms', () => {
    expect(normalizeAdminTrustedClientIp('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(normalizeAdminTrustedClientIp('2001:0DB8:0:0:0:0:0:1')).toBe(
      '2001:db8::1',
    );
  });

  it.each([undefined, '', 'unknown', '1.2.3.4, 5.6.7.8'])(
    'rejects an unavailable or non-canonical source without echoing it: %s',
    (value) => {
      expect(() => normalizeAdminTrustedClientIp(value)).toThrow(
        ServiceUnavailableException,
      );
    },
  );
});
