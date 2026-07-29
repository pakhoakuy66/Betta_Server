import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request as ExpressRequest, Response } from 'express';
import { Types } from 'mongoose';

import { createSuccessResponse } from '../../../common/interfaces/api-response.interface';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';
import { CompleteGoogleOAuthRegistrationDto } from '../dto/complete-google-oauth-registration.dto';
import { GoogleOAuthContinuationOriginGuard } from '../guards/google-oauth-continuation-origin.guard';
import { GoogleOAuthContinuationGrantPurpose } from '../schemas/google-oauth-continuation-grant.schema';
import { GoogleOAuthAccountLinkService } from '../services/google-oauth-account-link.service';
import { GoogleOAuthContinuationCookieService } from '../services/google-oauth-continuation-cookie.service';
import { GoogleOAuthRegistrationService } from '../services/google-oauth-registration.service';

type AuthenticatedExpressRequest = ExpressRequest & AuthenticatedRequest;

@Controller('auth/google/continuation')
@UseGuards(GoogleOAuthContinuationOriginGuard)
export class GoogleOAuthContinuationController {
  constructor(
    private readonly cookieService: GoogleOAuthContinuationCookieService,
    private readonly accountLinkService: GoogleOAuthAccountLinkService,
    private readonly registrationService: GoogleOAuthRegistrationService,
  ) {}

  @Post('link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  async linkAccount(
    @Req() request: AuthenticatedExpressRequest,
    @Res({ passthrough: true })
    response: Response,
  ) {
    if (!Types.ObjectId.isValid(request.user._id)) {
      throw new UnauthorizedException();
    }

    return this.consumeCookie(
      request,
      response,
      GoogleOAuthContinuationGrantPurpose.LINK_ACCOUNT,
      async (rawGrant) => {
        await this.accountLinkService.linkGoogleAccount(
          rawGrant,
          new Types.ObjectId(request.user._id),
        );

        return createSuccessResponse(null, 'Đã liên kết tài khoản Google');
      },
    );
  }

  @Post('registration')
  @HttpCode(HttpStatus.OK)
  async completeRegistration(
    @Req() request: ExpressRequest,
    @Res({ passthrough: true })
    response: Response,
    @Body()
    dto: CompleteGoogleOAuthRegistrationDto,
  ) {
    return this.consumeCookie(
      request,
      response,
      GoogleOAuthContinuationGrantPurpose.COMPLETE_REGISTRATION,
      async (rawGrant) => {
        const { message, ...session } =
          await this.registrationService.completeRegistration(rawGrant, dto, {
            userAgent: request.get('user-agent'),
          });

        return createSuccessResponse(session, message);
      },
    );
  }

  private async consumeCookie<T>(
    request: ExpressRequest,
    response: Response,
    purpose: GoogleOAuthContinuationGrantPurpose,
    operation: (rawGrant: string) => Promise<T>,
  ): Promise<T> {
    try {
      const rawGrant = this.cookieService.read(request, purpose);

      const result = await operation(rawGrant);

      this.cookieService.clear(response, purpose);

      return result;
    } catch (error: unknown) {
      if (this.cookieService.shouldClearAfterError(error)) {
        this.cookieService.clear(response, purpose);
      }

      throw error;
    }
  }
}
