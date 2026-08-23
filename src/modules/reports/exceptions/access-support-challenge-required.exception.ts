import { HttpException } from '@nestjs/common';
import {
  ACCESS_SUPPORT_CHALLENGE_ERROR,
  ACCESS_SUPPORT_CHALLENGE_MESSAGE,
} from '../constants/access-support.constants';

export type AccessSupportChallenge = Readonly<{
  token: string;
  difficultyBits: number;
  expiresAt: string;
}>;

export class AccessSupportChallengeRequiredException extends HttpException {
  constructor(challenge: AccessSupportChallenge) {
    super(
      {
        statusCode: 428,
        error: ACCESS_SUPPORT_CHALLENGE_ERROR,
        message: ACCESS_SUPPORT_CHALLENGE_MESSAGE,
        challenge,
      },
      428,
    );
  }
}
