import {
  ServiceUnavailableException,
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import type { ClientSession } from 'mongoose';
import { AuthAuditService } from './auth-audit.service';
import { MailService } from './mail.service';
import {
  AuthAuditEventCode,
  AuthAuditOutcome,
  AuthAuditReasonCode,
} from '../interfaces/auth-audit.interface';
import { isMongoInfrastructureError } from '../../../common/utils/is-mongo-infrastructure-error';
import { AuthSessionService } from './auth-session.service';
import type { SessionRequestMetadata } from '../interfaces/auth-session.interface';
import { generateUserPublicId } from '../../users/utils/generate-public-id';
import { User } from '../../users/schemas/user.schema';
import { SessionRevokeReason } from '../schemas/auth-session.schema';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from '../dto/auth.dto';
import {
  AuthResponse,
  PublicUser,
  RegisterResponse,
} from '../interfaces/auth.interface';
import { normalizeAuthEmail } from '../../../common/utils/normalize-auth-email';
import { toPublicAuthUser } from '../mappers/public-auth-user.mapper';
import { AccountRestrictedException } from '../exceptions/account-restricted.exception';
import { isActiveUserRestriction } from '../../users/utils/user-restriction';
import { AdminUserRestrictionExpiryService } from '../../admin/services/admin-user-restriction-expiry.service';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const BCRYPT_ROUNDS = 12;
const OTP_HASH_ROUNDS = 8;
const MAX_OTP_VERIFY_ATTEMPTS = 5;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_WINDOW_MS = 30 * 60 * 1000;
const GENERIC_FORGOT_PASSWORD_RESPONSE = {
  success: true,
  message: 'Nếu email hợp lệ, mã OTP sẽ được gửi đến địa chỉ đã đăng ký.',
};

const INVALID_LOGIN_MESSAGE = 'Email hoặc mật khẩu không chính xác';

// Hash giả có cùng bcrypt cost với mật khẩu thật để hạn chế dò email bằng timing.
const DUMMY_PASSWORD_HASH =
  '$2b$12$CwTycUXWue0Thq9StjUM0uJ8xgOguJdyQh7fXxH4ILhYo8sHpItCu';

// ─────────────────────────────────────────────
// Helper: ép kiểu err unknown → MongoError shape
// Dùng chung cho mọi catch block trong project
// ─────────────────────────────────────────────
interface MongoError {
  code?: number;
  stack?: string;
  message?: string;
  keyPattern?: Record<string, number>;
}

type FailedLoginAttemptResult = {
  lockedUntil: Date | null;
  didCreateLock: boolean;
};

function toMongoError(err: unknown): MongoError {
  if (typeof err === 'object' && err !== null) {
    return err as MongoError;
  }
  return { message: String(err) };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Cấu hình hằng số chuẩn cho OTP
  private readonly OTP_COOLDOWN_SECONDS = 60; // 60 giây
  private readonly OTP_EXPIRY_MINUTES = 3; // OTP hết hạn sau 3 phút

  constructor(
    @InjectConnection()
    private readonly connection: Connection,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    private readonly mailService: MailService,

    private readonly authSessionService: AuthSessionService,

    private readonly authAuditService: AuthAuditService,

    private readonly restrictionExpiryService: AdminUserRestrictionExpiryService,
  ) {}

  // ─────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────

  private async runAuthSecurityTransaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.connection.transaction(operation);
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (isMongoInfrastructureError(error)) {
        throw new ServiceUnavailableException(
          'Không thể hoàn tất thao tác bảo mật',
        );
      }

      throw error;
    }
  }

  private async createUserWithPublicId(data: {
    username: string;
    fullname: string;
    phone: string;
    email: string;
    password: string;
  }) {
    const MAX_PUBLIC_ID_RETRIES = 5;

    for (let attempt = 1; attempt <= MAX_PUBLIC_ID_RETRIES; attempt += 1) {
      try {
        return await this.userModel.create({
          ...data,
          publicId: generateUserPublicId(),
        });
      } catch (err: unknown) {
        const error = toMongoError(err);

        // NanoID collision rất hiếm, nhưng production vẫn phải xử lý bằng unique index + retry.
        if (error.code === 11000 && error.keyPattern?.publicId) {
          continue;
        }

        throw err;
      }
    }

    throw new InternalServerErrorException(
      'Không thể tạo mã người dùng, vui lòng thử lại',
    );
  }

  private ensureAccountCanUseAuth(
    user: Pick<User, 'isDeleted' | 'status' | 'restriction'>,
    now = new Date(),
  ) {
    if (user.isDeleted) {
      throw new UnauthorizedException(
        'Tài khoản không tồn tại hoặc đã bị khóa',
      );
    }
    if (isActiveUserRestriction(user.restriction, now)) {
      throw new AccountRestrictedException(user.restriction);
    }
    if (user.status === 'banned') {
      throw new UnauthorizedException(
        'Tài khoản không tồn tại hoặc đã bị khóa',
      );
    }
  }

  private isLoginLocked(
    user: Pick<User, 'lockedUntil'>,
    now: Date,
  ): user is Pick<User, 'lockedUntil'> & { lockedUntil: Date } {
    return Boolean(
      user.lockedUntil && user.lockedUntil.getTime() > now.getTime(),
    );
  }

  private throwLoginLocked(lockedUntil: Date): never {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
    );

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message:
          'Quá nhiều lần đăng nhập không thành công. Vui lòng thử lại sau.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async recordFailedLoginAttempt(
    userId: Types.ObjectId,
    now: Date,
  ): Promise<Date | null> {
    const nextLockedUntil = new Date(now.getTime() + LOGIN_LOCK_DURATION_MS);

    const failureWindowThreshold = new Date(
      now.getTime() - LOGIN_FAILURE_WINDOW_MS,
    );

    const result =
      await this.runAuthSecurityTransaction<FailedLoginAttemptResult>(
        async (session) => {
          const shouldStartNewWindow = {
            $or: [
              {
                $lte: [
                  {
                    $ifNull: ['$failedLoginWindowStartedAt', new Date(0)],
                  },
                  failureWindowThreshold,
                ],
              },
              {
                $and: [
                  {
                    $ne: [
                      {
                        $ifNull: ['$lockedUntil', null],
                      },
                      null,
                    ],
                  },
                  {
                    $lte: ['$lockedUntil', now],
                  },
                ],
              },
            ],
          };

          const updatedUser = await this.userModel
            .findOneAndUpdate(
              {
                _id: userId,
                isDeleted: false,
                status: { $ne: 'banned' },
                $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
              },
              [
                {
                  $set: {
                    failedLoginAttempts: {
                      $cond: [
                        shouldStartNewWindow,
                        1,
                        {
                          $add: [
                            {
                              $ifNull: ['$failedLoginAttempts', 0],
                            },
                            1,
                          ],
                        },
                      ],
                    },
                    failedLoginWindowStartedAt: {
                      $cond: [
                        shouldStartNewWindow,
                        now,
                        '$failedLoginWindowStartedAt',
                      ],
                    },
                  },
                },
                {
                  $set: {
                    lockedUntil: {
                      $cond: [
                        {
                          $gte: [
                            '$failedLoginAttempts',
                            MAX_FAILED_LOGIN_ATTEMPTS,
                          ],
                        },
                        nextLockedUntil,
                        '$$REMOVE',
                      ],
                    },
                  },
                },
              ],
              {
                session,
                returnDocument: 'after',
                updatePipeline: true,
              },
            )
            .select(
              '+failedLoginAttempts ' +
                '+failedLoginWindowStartedAt ' +
                '+lockedUntil',
            )
            .exec();

          if (!updatedUser) {
            const currentLock = await this.userModel
              .findOne(
                {
                  _id: userId,
                  isDeleted: false,
                },
                null,
                { session },
              )
              .select('+lockedUntil')
              .lean()
              .exec();

            const activeLock =
              currentLock?.lockedUntil &&
              currentLock.lockedUntil.getTime() > now.getTime()
                ? currentLock.lockedUntil
                : null;

            return {
              lockedUntil: activeLock,
              didCreateLock: false,
            };
          }

          const activeLock =
            updatedUser.lockedUntil &&
            updatedUser.lockedUntil.getTime() > now.getTime()
              ? updatedUser.lockedUntil
              : null;

          if (!activeLock) {
            return {
              lockedUntil: null,
              didCreateLock: false,
            };
          }

          await this.authAuditService.record({
            eventCode: AuthAuditEventCode.ACCOUNT_LOCKED,
            outcome: AuthAuditOutcome.SUCCEEDED,
            reasonCode: AuthAuditReasonCode.LOGIN_FAILURE_THRESHOLD,
            targetUserId: userId,
            actorUserId: null,
            mongoSession: session,
          });

          return {
            lockedUntil: activeLock,
            didCreateLock: true,
          };
        },
      );

    if (result.didCreateLock) {
      this.logger.warn(
        'Account temporarily locked after repeated login failures: ' +
          userId.toString(),
      );
    }

    return result.lockedUntil;
  }

  private generateOtpCode(): string {
    // crypto.randomInt phù hợp hơn Math.random cho OTP bảo mật.
    return randomInt(100000, 1000000).toString();
  }

  private async performDummyOtpHash(): Promise<void> {
    await this.hashOtp(this.generateOtpCode());
  }

  private async hashOtp(otp: string): Promise<string> {
    return bcrypt.hash(otp, OTP_HASH_ROUNDS);
  }

  private async isOtpMatched(
    otp: string,
    otpHash?: string | null,
  ): Promise<boolean> {
    if (!otpHash) return false;

    return bcrypt.compare(otp, otpHash);
  }

  // ─────────────────────────────────────────────
  // REGISTER
  // ─────────────────────────────────────────────

  async register(body: RegisterDto): Promise<RegisterResponse> {
    const username = body.username.trim();
    const fullname = body.fullname.trim();
    const phone = body.phone.trim();
    const email = normalizeAuthEmail(body.email);
    const password = body.password;

    const duplicate = await this.userModel
      .findOne({ $or: [{ username }, { email }, { phone }] })
      .select('username email phone')
      .lean()
      .exec();

    if (duplicate) {
      if (duplicate.username === username)
        throw new ConflictException(`Tên tài khoản "${username}" đã tồn tại`);
      if (duplicate.email === email)
        throw new ConflictException('Email này đã được sử dụng');
      if (duplicate.phone === phone)
        throw new ConflictException('Số điện thoại này đã được sử dụng');
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    try {
      await this.createUserWithPublicId({
        username,
        fullname,
        phone,
        email,
        password: hashedPassword,
      });
    } catch (err: unknown) {
      // ✅ Fix: ép kiểu rõ ràng trước khi truy cập property
      const error = toMongoError(err);

      if (error.code === 11000) {
        throw new ConflictException('Thông tin đăng ký đã tồn tại');
      }

      this.logger.error('Register failed', error.stack);
      throw new InternalServerErrorException(
        'Đăng ký thất bại, vui lòng thử lại',
      );
    }

    return {
      success: true,
      message: 'Đăng ký thành công!',
    };
  }

  // ─────────────────────────────────────────────
  // LOGIN
  // ─────────────────────────────────────────────

  async login(
    body: LoginDto,
    metadata: SessionRequestMetadata,
  ): Promise<AuthResponse> {
    const email = normalizeAuthEmail(body.email);
    const password = body.password;

    const user = await this.userModel
      .findOne({
        email,
        isDeleted: false,
      })
      .select(
        '+password +failedLoginAttempts +failedLoginWindowStartedAt ' +
          '+lockedUntil +restriction +authzVersion',
      )
      .exec();

    /*
     * Luôn chạy bcrypt, kể cả email không tồn tại, để giảm chênh lệch
     * thời gian phản hồi có thể bị dùng để dò tài khoản.
     */
    const localPasswordHash =
      typeof user?.password === 'string' && user.password.length > 0
        ? user.password
        : undefined;

    const passwordHash = localPasswordHash ?? DUMMY_PASSWORD_HASH;

    const isPasswordValid = await bcrypt.compare(password, passwordHash);

    if (!user || !localPasswordHash) {
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    const credentialCheckedAt = new Date();

    if (this.isLoginLocked(user, credentialCheckedAt)) {
      this.throwLoginLocked(user.lockedUntil);
    }

    if (!isPasswordValid) {
      const lockedUntil = await this.recordFailedLoginAttempt(
        user._id,
        credentialCheckedAt,
      );

      if (lockedUntil) {
        this.throwLoginLocked(lockedUntil);
      }

      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    /*
     * Chỉ cấp phiên nếu credential và account state vẫn hợp lệ sau bcrypt.
     * Không khóa theo authzVersion của snapshot ban đầu: expiry worker có thể
     * tăng version hợp lệ trong lúc bcrypt chạy. Query này vẫn fail-closed cho
     * password change, delete, ban và login lock; transaction write conflict
     * bảo vệ thay đổi moderation xảy ra đồng thời.
     * Refresh-token hash được lưu riêng trong auth_sessions khi tạo session.
     */
    const loginResult = await this.connection.transaction(async (session) => {
      const authenticationTime = new Date();

      /*
       * Khóa credential state đã được bcrypt xác minh.
       * Nếu password thay đổi trong lúc bcrypt chạy,
       * query không match và không tạo session.
       */
      const authenticatedUser = await this.userModel
        .findOneAndUpdate(
          {
            _id: user._id,
            password: user.password,
            isDeleted: false,
            status: 'active',
            $or: [
              { lockedUntil: null },
              { lockedUntil: { $lte: authenticationTime } },
            ],
          },
          {
            $set: {
              failedLoginAttempts: 0,
            },
            $unset: {
              lockedUntil: '',
              failedLoginWindowStartedAt: '',
            },
          },
          {
            session,
            returnDocument: 'after',
            runValidators: true,
          },
        )
        .select('+password +authzVersion +restriction')
        .exec();

      if (!authenticatedUser) {
        return null;
      }

      this.ensureAccountCanUseAuth(authenticatedUser, authenticationTime);

      const expiry =
        await this.restrictionExpiryService.convergeForAuthentication(
          authenticatedUser._id,
          authenticationTime,
          session,
        );
      if (expiry) {
        authenticatedUser.restriction = null;
        authenticatedUser.version = expiry.afterVersion;
        authenticatedUser.authzVersion = expiry.authzVersion;
      }

      /*
       * User CAS và auth_session insert cùng transaction.
       * Không còn khoảng trống để session dùng password cũ
       * được tạo sau password-change revoke-all.
       */
      const tokens = await this.authSessionService.createSession(
        authenticatedUser,
        metadata,
        session,
      );

      return {
        authenticatedUser,
        tokens,
      };
    });

    if (!loginResult) {
      const latestUser = await this.userModel
        .findById(user._id)
        .select('+password +lockedUntil +restriction')
        .exec();

      const latestCheckTime = new Date();

      if (
        latestUser &&
        typeof latestUser.password === 'string' &&
        latestUser.password === user.password
      ) {
        if (this.isLoginLocked(latestUser, latestCheckTime)) {
          this.throwLoginLocked(latestUser.lockedUntil);
        }

        if (isActiveUserRestriction(latestUser.restriction, latestCheckTime)) {
          throw new AccountRestrictedException(latestUser.restriction);
        }
      }

      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    const { authenticatedUser, tokens } = loginResult;

    this.logger.log(`User logged in: ${authenticatedUser._id.toString()}`);

    return {
      message: 'Đăng nhập thành công',
      ...tokens,
      user: toPublicAuthUser(authenticatedUser),
    };
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.userModel
      .findOne({
        _id: userId,
        isDeleted: false,
        status: 'active',
      })
      .exec();

    if (!user) {
      throw new UnauthorizedException(
        'Tài khoản không tồn tại hoặc đã bị khóa',
      );
    }

    return toPublicAuthUser(user);
  }

  // BƯỚC 1: Gửi OTP
  async forgotPassword(body: ForgotPasswordDto) {
    const email = normalizeAuthEmail(body.email);

    const user = await this.userModel
      .findOne({
        email,
        isDeleted: false,
        status: 'active',
      })
      .select('+forgotPasswordOtp +forgotPasswordExpiry'); // Lấy thêm các trường ẩn

    if (!user) {
      await this.performDummyOtpHash();
      return GENERIC_FORGOT_PASSWORD_RESPONSE;
    }

    // --- LOGIC RATE LIMITING CHUẨN DOANH NGHIỆP ---
    if (user.forgotPasswordExpiry) {
      const now = new Date();
      // Tính thời điểm mà User được phép gửi lại (Thường là: Thời điểm hết hạn - (Thời gian sống của OTP - 60s))
      // Cách dễ nhất: Lấy (Thời điểm hết hạn - 3 phút) + 60 giây.
      const lastSentAt = new Date(
        user.forgotPasswordExpiry.getTime() -
          this.OTP_EXPIRY_MINUTES * 60 * 1000,
      );
      const secondsPassed = Math.floor(
        (now.getTime() - lastSentAt.getTime()) / 1000,
      );

      if (secondsPassed < this.OTP_COOLDOWN_SECONDS) {
        await this.performDummyOtpHash();
        return GENERIC_FORGOT_PASSWORD_RESPONSE;
      }
    }

    // Tạo mã OTP 6 số ngẫu nhiên
    const otp = this.generateOtpCode();

    // Lưu OTP vào DB với thời hạn 3 phút (Standard)
    user.forgotPasswordOtp = await this.hashOtp(otp);
    user.forgotPasswordExpiry = new Date(
      Date.now() + this.OTP_EXPIRY_MINUTES * 60 * 1000,
    );
    user.forgotPasswordAttempts = 0;

    await user.save();

    // Gửi email thật cho User thay vì log console
    try {
      await this.mailService.sendOtpEmail(email, otp);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        `[AUTH_OTP_DELIVERY_FAILED] ${errorMessage}`,
        errorStack,
      );

      user.forgotPasswordOtp = undefined;
      user.forgotPasswordExpiry = undefined;
      user.forgotPasswordAttempts = 0;
      await user.save();

      return GENERIC_FORGOT_PASSWORD_RESPONSE;
    }

    return GENERIC_FORGOT_PASSWORD_RESPONSE;
  }

  // BƯỚC 2: Verify OTP
  async verifyOtp(body: VerifyOtpDto) {
    const email = normalizeAuthEmail(body.email);
    const user = await this.userModel
      .findOne({
        email,
        isDeleted: false,
        status: 'active',
      })
      .select(
        '+forgotPasswordOtp +forgotPasswordExpiry +forgotPasswordAttempts',
      );

    const isExpired =
      !user?.forgotPasswordExpiry || user.forgotPasswordExpiry < new Date();

    if (!user || isExpired) {
      throw new UnauthorizedException('OTP sai hoặc đã hết hạn');
    }

    if ((user.forgotPasswordAttempts ?? 0) >= MAX_OTP_VERIFY_ATTEMPTS) {
      user.forgotPasswordOtp = undefined;
      user.forgotPasswordExpiry = undefined;
      user.forgotPasswordAttempts = 0;
      await user.save();

      throw new UnauthorizedException(
        'Bạn đã nhập sai OTP quá nhiều lần, vui lòng yêu cầu mã mới',
      );
    }

    const isOtpValid = await this.isOtpMatched(
      body.otp,
      user.forgotPasswordOtp,
    );

    if (!isOtpValid) {
      user.forgotPasswordAttempts = (user.forgotPasswordAttempts ?? 0) + 1;
      await user.save();

      throw new UnauthorizedException('OTP sai hoặc đã hết hạn');
    }

    return { success: true, message: 'OTP hợp lệ' };
  }

  // BƯỚC 3: Đổi mật khẩu mới
  async resetPassword(body: ResetPasswordDto) {
    const email = normalizeAuthEmail(body.email);

    const { otp, newPassword } = body;

    const now = new Date();

    const user = await this.userModel
      .findOne({
        email,
        isDeleted: false,
        status: 'active',
      })
      .select(
        [
          '+password',
          '+forgotPasswordOtp',
          '+forgotPasswordExpiry',
          '+forgotPasswordAttempts',
          '+failedLoginAttempts',
          '+failedLoginWindowStartedAt',
          '+lockedUntil',
        ].join(' '),
      )
      .exec();

    if (
      !user ||
      !user.forgotPasswordOtp ||
      !user.forgotPasswordExpiry ||
      user.forgotPasswordExpiry <= now
    ) {
      throw new BadRequestException('OTP không hợp lệ hoặc đã hết hạn');
    }

    if ((user.forgotPasswordAttempts ?? 0) >= MAX_OTP_VERIFY_ATTEMPTS) {
      user.forgotPasswordOtp = undefined;
      user.forgotPasswordExpiry = undefined;
      user.forgotPasswordAttempts = 0;

      await user.save();

      throw new BadRequestException(
        'Bạn đã nhập sai OTP quá nhiều lần, vui lòng yêu cầu mã mới',
      );
    }

    const expectedOtpHash = user.forgotPasswordOtp;

    const expectedPasswordHash = user.password;

    const isOtpValid = await this.isOtpMatched(otp, expectedOtpHash);

    if (!isOtpValid) {
      user.forgotPasswordAttempts = (user.forgotPasswordAttempts ?? 0) + 1;

      await user.save();

      throw new BadRequestException('OTP không hợp lệ');
    }

    const isSamePassword = expectedPasswordHash
      ? await bcrypt.compare(newPassword, expectedPasswordHash)
      : false;

    if (isSamePassword) {
      throw new BadRequestException(
        'Mật khẩu mới không được trùng với mật khẩu hiện tại',
      );
    }

    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    const userId = new Types.ObjectId(user._id.toString());

    const passwordVersionFilter = expectedPasswordHash
      ? {
          password: expectedPasswordHash,
        }
      : {
          password: {
            $exists: false,
          },
        };

    await this.runAuthSecurityTransaction(async (session) => {
      const transactionNow = new Date();

      const updateResult = await this.userModel
        .updateOne(
          {
            _id: userId,
            ...passwordVersionFilter,
            forgotPasswordOtp: expectedOtpHash,
            forgotPasswordExpiry: {
              $gt: transactionNow,
            },
            isDeleted: false,
            status: 'active',
            $or: [
              {
                forgotPasswordAttempts: {
                  $lt: MAX_OTP_VERIFY_ATTEMPTS,
                },
              },
              {
                forgotPasswordAttempts: {
                  $exists: false,
                },
              },
            ],
          },
          {
            $set: {
              password: newPasswordHash,
              forgotPasswordAttempts: 0,
              failedLoginAttempts: 0,
            },
            $unset: {
              forgotPasswordOtp: '',
              forgotPasswordExpiry: '',
              failedLoginWindowStartedAt: '',
              lockedUntil: '',
            },
          },
          {
            session,
            runValidators: true,
          },
        )
        .exec();

      if (updateResult.matchedCount !== 1) {
        throw new BadRequestException(
          'OTP hoặc trạng thái xác thực đã thay đổi, vui lòng thử lại',
        );
      }

      const affectedSessionCount =
        await this.authSessionService.revokeAllSessions(
          userId,
          SessionRevokeReason.PASSWORD_RESET,
          session,
        );

      await this.authAuditService.record({
        eventCode: AuthAuditEventCode.PASSWORD_RESET,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.PASSWORD_RESET_COMPLETED,
        targetUserId: userId,
        actorUserId: null,
        metadata: {
          affectedSessionCount,
        },
        mongoSession: session,
      });
    });

    this.logger.log(`User reset password: ${userId.toString()}`);

    return {
      success: true,
      message: 'Đổi mật khẩu thành công!',
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const { currentPassword, newPassword, confirmPassword } = dto;

    if (newPassword !== confirmPassword) {
      throw new BadRequestException('Mật khẩu xác nhận không khớp');
    }

    if (!Types.ObjectId.isValid(userId)) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    const uid = new Types.ObjectId(userId);

    const user = await this.userModel
      .findOne({
        _id: uid,
        isDeleted: false,
        status: 'active',
      })
      .select('+password')
      .exec();

    if (!user) {
      throw new UnauthorizedException(
        'Tài khoản không tồn tại hoặc đã bị khóa',
      );
    }

    const expectedPasswordHash = user.password;

    if (!expectedPasswordHash) {
      throw new BadRequestException(
        'Tài khoản chưa thiết lập mật khẩu. Vui lòng dùng chức năng quên mật khẩu để tạo mật khẩu.',
      );
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword,
      expectedPasswordHash,
    );

    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Mật khẩu hiện tại không chính xác');
    }

    const isSamePassword = await bcrypt.compare(
      newPassword,
      expectedPasswordHash,
    );

    if (isSamePassword) {
      throw new BadRequestException(
        'Mật khẩu mới không được trùng với mật khẩu hiện tại',
      );
    }

    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.runAuthSecurityTransaction(async (session) => {
      const updateResult = await this.userModel
        .updateOne(
          {
            _id: uid,
            password: expectedPasswordHash,
            isDeleted: false,
            status: 'active',
          },
          {
            $set: {
              password: newPasswordHash,
            },
          },
          {
            session,
            runValidators: true,
          },
        )
        .exec();

      if (updateResult.matchedCount !== 1) {
        throw new UnauthorizedException(
          'Thông tin xác thực đã thay đổi, vui lòng thử lại',
        );
      }

      const affectedSessionCount =
        await this.authSessionService.revokeAllSessions(
          uid,
          SessionRevokeReason.PASSWORD_CHANGED,
          session,
        );

      await this.authAuditService.record({
        eventCode: AuthAuditEventCode.PASSWORD_CHANGED,
        outcome: AuthAuditOutcome.SUCCEEDED,
        reasonCode: AuthAuditReasonCode.PASSWORD_CHANGE_COMPLETED,
        targetUserId: uid,
        actorUserId: uid,
        metadata: {
          affectedSessionCount,
        },
        mongoSession: session,
      });
    });

    this.logger.log(`User changed password: ${uid.toString()}`);

    return {
      success: true,
      message: 'Đổi mật khẩu thành công, vui lòng đăng nhập lại',
    };
  }

  async logout(userId: string, sessionId: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }

    await this.authSessionService.revokeCurrentSession(
      new Types.ObjectId(userId),
      sessionId,
    );

    return {
      success: true,
      message: 'Đăng xuất thành công!',
    };
  }

  refreshToken(refreshToken: string) {
    return this.authSessionService.rotateRefreshToken(refreshToken);
  }
}
