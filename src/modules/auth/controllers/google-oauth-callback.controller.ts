import {
  BadRequestException,
  Controller,
  Get,
  HttpStatus,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import {
  GOOGLE_OAUTH_CALLBACK_ROUTE,
  GOOGLE_OAUTH_CONTROLLER_ROUTE,
} from '../constants/google-oauth-route.constants';
import {
  GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT,
  GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF,
  type GoogleOAuthCallbackResult,
} from '../interfaces/google-oauth-callback.interface';
import { GoogleOAuthTransactionInvalidException } from '../exceptions/google-oauth-transaction-invalid.exception';
import { GoogleOAuthAccountResolutionStatus } from '../interfaces/google-oauth-account-resolution.interface';
import { GoogleOAuthContinuationGrantPurpose } from '../schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthCallbackService } from '../services/google-oauth-callback.service';
import { GoogleOAuthContinuationCookieService } from '../services/google-oauth-continuation-cookie.service';
import {
  GoogleOAuthFrontendDestination,
  GoogleOAuthFrontendRedirectService,
} from '../services/google-oauth-frontend-redirect.service';
import { GoogleOAuthSessionHandoffCookieService } from '../services/google-oauth-session-handoff-cookie.service';
import { GoogleOAuthStateCookieService } from '../services/google-oauth-state-cookie.service';
import { AccountRestrictedException } from '../exceptions/account-restricted.exception';
import { normalizePublicAccountRestriction } from '../../../common/security/public-account-restriction';

const INVALID_CALLBACK_MESSAGE = 'Yeu cau callback Google OAuth khong hop le';

const MAX_AUTHORIZATION_CODE_LENGTH = 8_192;
const MAX_PROVIDER_ERROR_LENGTH = 128;
const PROVIDER_ERROR_PATTERN = /^[A-Za-z0-9_.-]+$/u;

type ParsedCallbackQuery =
  | {
      kind: 'SUCCESS';
      state: string;
      authorizationCode: string;
    }
  | {
      kind: 'PROVIDER_ERROR';
      state: string;
      providerError: string;
    };

@ApiTags('Authentication')
@Controller(GOOGLE_OAUTH_CONTROLLER_ROUTE)
export class GoogleOAuthCallbackController {
  constructor(
    private readonly callbackService: GoogleOAuthCallbackService,
    private readonly stateCookieService: GoogleOAuthStateCookieService,
    private readonly continuationCookieService: GoogleOAuthContinuationCookieService,
    private readonly handoffCookieService: GoogleOAuthSessionHandoffCookieService,
    private readonly redirectService: GoogleOAuthFrontendRedirectService,
  ) {}

  @Get(GOOGLE_OAUTH_CALLBACK_ROUTE)
  @ApiOperation({
    summary: 'Xu ly callback Google OAuth',
  })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description: 'Chuyen huong ve luong Frontend co dinh',
  })
  async handleCallback(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.applyPrivateHeaders(response);

    let callbackResult: GoogleOAuthCallbackResult | null = null;
    let destination: GoogleOAuthFrontendDestination | null = null;

    try {
      const browserState = this.stateCookieService.read(request);

      const query = this.parseQuery(request.query);

      if (query.kind === 'PROVIDER_ERROR') {
        await this.callbackService.consumeRejectedCallback(
          query.state,
          browserState,
        );

        destination =
          query.providerError === 'access_denied'
            ? GoogleOAuthFrontendDestination.CANCELLED
            : GoogleOAuthFrontendDestination.ERROR;
      } else {
        callbackResult = await this.callbackService.handleCallback({
          authorizationCode: query.authorizationCode,
          callbackState: query.state,
          browserState,
          metadata: {
            userAgent: request.get('user-agent'),
          },
        });
      }
    } catch (error: unknown) {
      this.stateCookieService.clear(response);

      if (error instanceof AccountRestrictedException) {
        const raw = error.getResponse();
        const body =
          typeof raw === 'object' && raw !== null
            ? (raw as Record<string, unknown>)
            : {};
        const publicRestriction = normalizePublicAccountRestriction(
          body.publicRestriction,
        );
        if (!publicRestriction) {
          throw new TypeError('Invalid public account restriction');
        }
        this.sendEmptyRedirect(
          response,
          this.redirectService.createRestrictionUrl(publicRestriction),
        );
        return;
      }

      if (error instanceof GoogleOAuthTransactionInvalidException) {
        this.sendEmptyRedirect(
          response,
          this.redirectService.createUrl(GoogleOAuthFrontendDestination.ERROR),
        );
        return;
      }

      throw error;
    }

    this.stateCookieService.clear(response);

    if (callbackResult) {
      destination = this.writeOutcomeCookie(response, callbackResult);
    }

    if (!destination) {
      throw new TypeError(
        'Google OAuth callback did not produce a destination',
      );
    }

    this.sendEmptyRedirect(
      response,
      this.redirectService.createUrl(destination),
    );
  }

  private parseQuery(query: Request['query']): ParsedCallbackQuery {
    const state = this.readSingleValue(query.state, 512);

    const authorizationCode = this.readOptionalSingleValue(
      query.code,
      MAX_AUTHORIZATION_CODE_LENGTH,
    );

    const providerError = this.readOptionalSingleValue(
      query.error,
      MAX_PROVIDER_ERROR_LENGTH,
    );

    if ((authorizationCode === undefined) === (providerError === undefined)) {
      throw new BadRequestException(INVALID_CALLBACK_MESSAGE);
    }

    if (providerError !== undefined) {
      if (!PROVIDER_ERROR_PATTERN.test(providerError)) {
        throw new BadRequestException(INVALID_CALLBACK_MESSAGE);
      }

      return {
        kind: 'PROVIDER_ERROR',
        state,
        providerError,
      };
    }

    if (authorizationCode === undefined) {
      throw new BadRequestException(INVALID_CALLBACK_MESSAGE);
    }

    return {
      kind: 'SUCCESS',
      state,
      authorizationCode,
    };
  }

  private readSingleValue(value: unknown, maxLength: number): string {
    const parsed = this.readOptionalSingleValue(value, maxLength);

    if (parsed === undefined) {
      throw new BadRequestException(INVALID_CALLBACK_MESSAGE);
    }

    return parsed;
  }

  private readOptionalSingleValue(
    value: unknown,
    maxLength: number,
  ): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maxLength
    ) {
      throw new BadRequestException(INVALID_CALLBACK_MESSAGE);
    }

    return value;
  }

  private writeOutcomeCookie(
    response: Response,
    result: GoogleOAuthCallbackResult,
  ): GoogleOAuthFrontendDestination {
    switch (result.status) {
      case GoogleOAuthAccountResolutionStatus.SIGN_IN:
        this.handoffCookieService.write(
          response,
          result[GOOGLE_OAUTH_INTERNAL_SESSION_HANDOFF],
        );

        return GoogleOAuthFrontendDestination.SESSION;

      case GoogleOAuthAccountResolutionStatus.ACCOUNT_LINK_REQUIRED:
        this.continuationCookieService.write(
          response,
          GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
          result[GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT],
        );

        return GoogleOAuthFrontendDestination.LINK;

      case GoogleOAuthAccountResolutionStatus.REGISTRATION_REQUIRED:
        this.continuationCookieService.write(
          response,
          GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
          result[GOOGLE_OAUTH_INTERNAL_CONTINUATION_GRANT],
        );

        return GoogleOAuthFrontendDestination.REGISTRATION;

      default:
        return this.assertNever(result);
    }
  }

  private sendEmptyRedirect(response: Response, location: string): void {
    response.statusCode = HttpStatus.FOUND;
    response.setHeader('Location', location);
    response.end();
  }

  private applyPrivateHeaders(response: Response): void {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
  }

  private assertNever(value: never): never {
    void value;

    throw new TypeError('Unsupported Google OAuth callback result');
  }
}
