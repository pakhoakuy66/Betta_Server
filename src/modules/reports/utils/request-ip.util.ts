import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

export type ReportRequest = AuthenticatedRequest & {
  ip?: string;
  socket?: {
    remoteAddress?: string | null;
  };
};

export const getRequestIp = (request: ReportRequest): string | undefined => {
  const requestIp = request.ip?.trim();

  if (requestIp) {
    return requestIp;
  }

  const socketIp = request.socket?.remoteAddress?.trim();

  return socketIp || undefined;
};
