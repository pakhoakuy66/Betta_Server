import type { INestApplication } from '@nestjs/common';
import type { RequestHandler } from 'express';
import {
  ACCESS_SUPPORT_CHALLENGE_HEADER,
  ACCESS_SUPPORT_HTTP_PATH,
  ACCESS_SUPPORT_ROUTE_CHALLENGE_FINGERPRINT,
} from '../constants/access-support.constants';
import { AccessSupportRateLimitService } from '../services/access-support-rate-limit.service';
import {
  type AccessSupportAttemptRequest,
  markAccessSupportIpAttempt,
} from '../utils/access-support-attempt.util';
import { getRequestIp } from '../utils/request-ip.util';
import { applyAccessSupportPrivateHeaders } from '../utils/access-support-response.util';

export const installAccessSupportAttemptMiddleware = (
  app: INestApplication,
): void => {
  const rateLimit = app.get(AccessSupportRateLimitService, { strict: false });

  const middleware: RequestHandler = (request, response, next) => {
    if (request.method.toUpperCase() !== 'POST') {
      next();
      return;
    }

    applyAccessSupportPrivateHeaders(response);
    const accessRequest = request as AccessSupportAttemptRequest;

    void rateLimit
      .consumeIp(
        getRequestIp(accessRequest),
        ACCESS_SUPPORT_ROUTE_CHALLENGE_FINGERPRINT,
        request.get(ACCESS_SUPPORT_CHALLENGE_HEADER),
      )
      .then(() => {
        markAccessSupportIpAttempt(accessRequest);
        next();
      })
      .catch((error: unknown) => next(error));
  };

  app.use(ACCESS_SUPPORT_HTTP_PATH, middleware);
};
