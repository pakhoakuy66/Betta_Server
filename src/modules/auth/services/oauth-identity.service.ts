import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Model, Types } from 'mongoose';
import {
  GOOGLE_SUBJECT_MAX_LENGTH,
  GOOGLE_SUBJECT_PATTERN,
  OAuthIdentity,
  OAuthProvider,
} from '../schemas/oauth-identity.schema';

@Injectable()
export class OAuthIdentityService {
  constructor(
    @InjectModel(OAuthIdentity.name)
    private readonly identityModel: Model<OAuthIdentity>,
  ) {}

  async resolveGoogleUserId(
    googleSubject: string,
    mongoSession?: ClientSession,
  ): Promise<Types.ObjectId | null> {
    this.assertGoogleSubject(googleSubject);

    const query = this.identityModel
      .findOne({
        provider: OAuthProvider.GOOGLE,
        providerAccountId: googleSubject,
      })
      .select({
        userId: 1,
        _id: 0,
      })
      .lean<{
        userId: Types.ObjectId;
      }>();

    if (mongoSession) {
      query.session(mongoSession);
    }

    const identity = await query.exec();

    return identity?.userId ?? null;
  }

  async hasGoogleLinkConflict(
    userId: Types.ObjectId,
    googleSubject: string,
    mongoSession: ClientSession,
  ): Promise<boolean> {
    if (!(userId instanceof Types.ObjectId)) {
      throw new TypeError('userId must be a MongoDB ObjectId');
    }

    if (!mongoSession) {
      throw new TypeError('mongoSession is required');
    }

    this.assertGoogleSubject(googleSubject);

    const conflict = await this.identityModel
      .findOne({
        provider: OAuthProvider.GOOGLE,
        $or: [
          {
            providerAccountId: googleSubject,
          },
          {
            userId,
          },
        ],
      })
      .select({
        _id: 1,
      })
      .session(mongoSession)
      .lean<{
        _id: Types.ObjectId;
      } | null>()
      .exec();

    return conflict !== null;
  }

  async createGoogleIdentity(
    userId: Types.ObjectId,
    googleSubject: string,
    mongoSession: ClientSession,
  ): Promise<void> {
    if (!(userId instanceof Types.ObjectId)) {
      throw new TypeError('userId must be a MongoDB ObjectId');
    }

    if (!mongoSession) {
      throw new TypeError('mongoSession is required');
    }

    this.assertGoogleSubject(googleSubject);

    try {
      await this.identityModel.insertMany(
        [
          {
            userId,
            provider: OAuthProvider.GOOGLE,
            providerAccountId: googleSubject,
          },
        ],
        {
          session: mongoSession,
          ordered: true,
        },
      );
    } catch (error: unknown) {
      if (this.isDuplicateKey(error)) {
        throw new ConflictException('Không thể liên kết tài khoản Google');
      }

      throw error;
    }
  }

  async deleteGoogleIdentity(
    userId: Types.ObjectId,
    mongoSession: ClientSession,
  ): Promise<boolean> {
    if (!(userId instanceof Types.ObjectId)) {
      throw new TypeError('userId must be a MongoDB ObjectId');
    }

    if (!mongoSession) {
      throw new TypeError('mongoSession is required');
    }

    if (!mongoSession.inTransaction()) {
      throw new TypeError('mongoSession must be in an active transaction');
    }

    const identity = await this.identityModel
      .findOneAndDelete({
        userId,
        provider: OAuthProvider.GOOGLE,
      })
      .select({
        _id: 1,
      })
      .session(mongoSession)
      .lean<{
        _id: Types.ObjectId;
      } | null>()
      .exec();

    return identity !== null;
  }

  private assertGoogleSubject(value: string): void {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > GOOGLE_SUBJECT_MAX_LENGTH ||
      !GOOGLE_SUBJECT_PATTERN.test(value)
    ) {
      throw new TypeError('Invalid Google subject');
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const code = (error as Record<string, unknown>).code;

    return code === 11000 || code === '11000';
  }
}
