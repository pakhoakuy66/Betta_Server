import { HttpException, HttpStatus } from '@nestjs/common';
import type { UserRestriction } from '../../users/schemas/user.schema';
import { toPublicUserRestriction } from '../../users/utils/user-restriction';
import { ACCOUNT_RESTRICTED_ERROR } from '../../../common/security/public-account-restriction';

export const ACCOUNT_RESTRICTED_MESSAGE =
  'Tài khoản đang bị hạn chế truy cập' as const;

export class AccountRestrictedException extends HttpException {
  constructor(restriction: UserRestriction) {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        error: ACCOUNT_RESTRICTED_ERROR,
        message: ACCOUNT_RESTRICTED_MESSAGE,
        publicRestriction: toPublicUserRestriction(restriction),
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
