import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

export type PublicReportRequest = {
  ip?: string;
  socket?: {
    remoteAddress?: string | null;
  };
};

export type ReportRequest = AuthenticatedRequest & PublicReportRequest;

export const getRequestIp = (
  request: PublicReportRequest,
): string | undefined => {
  const requestIp = request.ip?.trim();

  if (requestIp) {
    return requestIp;
  }

  const socketIp = request.socket?.remoteAddress?.trim();

  return socketIp || undefined;
};
