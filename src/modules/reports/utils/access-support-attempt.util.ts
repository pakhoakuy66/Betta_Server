import type { Request } from 'express';
import type { PublicReportRequest } from './request-ip.util';

const ACCESS_SUPPORT_IP_ATTEMPT = Symbol('access-support-ip-attempt');

export type AccessSupportAttemptRequest = Request &
  PublicReportRequest & {
    rawBody?: Buffer;
    [ACCESS_SUPPORT_IP_ATTEMPT]?: true;
  };

export const markAccessSupportIpAttempt = (
  request: AccessSupportAttemptRequest,
): void => {
  request[ACCESS_SUPPORT_IP_ATTEMPT] = true;
};

export const hasAccessSupportIpAttempt = (
  request: AccessSupportAttemptRequest,
): boolean => request[ACCESS_SUPPORT_IP_ATTEMPT] === true;
