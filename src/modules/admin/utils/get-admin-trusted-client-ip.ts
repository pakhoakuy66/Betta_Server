import { ServiceUnavailableException } from '@nestjs/common';
import { isIP } from 'node:net';

export type AdminClientIpRequest = Readonly<{
  ip?: string;
  socket: Readonly<{ remoteAddress?: string }>;
}>;

const CLIENT_IP_UNAVAILABLE_MESSAGE =
  'Không thể xác định nguồn yêu cầu đăng nhập';

export const normalizeAdminTrustedClientIp = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new ServiceUnavailableException(CLIENT_IP_UNAVAILABLE_MESSAGE);
  }

  let candidate = value.trim();
  if (candidate.startsWith('::ffff:')) {
    const mappedIpv4 = candidate.slice('::ffff:'.length);
    if (isIP(mappedIpv4) === 4) candidate = mappedIpv4;
  }

  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version !== 6) {
    throw new ServiceUnavailableException(CLIENT_IP_UNAVAILABLE_MESSAGE);
  }

  const hostname = new URL(`http://[${candidate}]/`).hostname;
  return hostname.slice(1, -1).toLowerCase();
};

export const getAdminTrustedClientIp = (
  request: AdminClientIpRequest,
): string =>
  normalizeAdminTrustedClientIp(request.ip ?? request.socket.remoteAddress);
