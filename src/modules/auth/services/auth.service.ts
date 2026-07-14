import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { MailService } from './mail.service';
import { generateUserPublicId } from '../../users/utils/generate-public-id';
import {
  DEFAULT_AVATAR_ID,
  DEFAULT_NOTIFICATION_SETTINGS,
  User,
  type NotificationSettings,
} from '../../users/schemas/user.schema';
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
  TokenPayload,
} from '../interfaces/auth.interface';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_HASH_ROUNDS = 10;
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

type RefreshTokenPayload = {
  sub: string;
};

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
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  // ─────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────

  private generateToken(user: User): string {
    const payload: TokenPayload = {
      sub: String(user._id),
      email: user.email,
      username: user.username,
    };
    // Access Token sống siêu ngắn (15 phút)
    return this.jwtService.sign(payload, { expiresIn: '15m' });
  }

  private generateRefreshToken(user: User): string {
    return this.jwtService.sign({ sub: String(user._id) }, { expiresIn: '7d' });
  }

  private async hashRefreshToken(refreshToken: string): Promise<string> {
    return bcrypt.hash(refreshToken, REFRESH_TOKEN_HASH_ROUNDS);
  }

  private async isRefreshTokenMatched(
    refreshToken: string,
    refreshTokenHash?: string | null,
  ): Promise<boolean> {
    if (!refreshTokenHash) return false;

    return bcrypt.compare(refreshToken, refreshTokenHash);
  }

  private normalizeNotificationSettings(
    settings?: Partial<NotificationSettings> | null,
  ): NotificationSettings {
    return {
      enabled: settings?.enabled ?? DEFAULT_NOTIFICATION_SETTINGS.enabled,
      follow: settings?.follow ?? DEFAULT_NOTIFICATION_SETTINGS.follow,
      reaction: settings?.reaction ?? DEFAULT_NOTIFICATION_SETTINGS.reaction,
      recap: settings?.recap ?? DEFAULT_NOTIFICATION_SETTINGS.recap,
    };
  }

  private toPublicUser(user: User): PublicUser {
    return {
      id: user.publicId,
      publicId: user.publicId,
      username: user.username,
      fullname: user.fullname,
      email: user.email,
      phone: user.phone,
      avatar: user.avatar ?? null,
      hasCustomAvatar: user.avatarId !== DEFAULT_AVATAR_ID,
      streakCount: user.streakCount ?? 0,
      status: user.status ?? 'active',
      notificationSettings: this.normalizeNotificationSettings(
        user.notificationSettings,
      ),
    };
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

  private ensureAccountCanUseAuth(user: Pick<User, 'isDeleted' | 'status'>) {
    if (user.isDeleted || user.status === 'banned') {
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
    const lockedUntil = new Date(now.getTime() + LOGIN_LOCK_DURATION_MS);
    const failureWindowThreshold = new Date(
      now.getTime() - LOGIN_FAILURE_WINDOW_MS,
    );

    /*
     * Bắt đầu cửa sổ mới khi:
     * - User chưa từng đăng nhập sai.
     * - Cửa sổ 30 phút trước đã hết.
     * - Tài khoản vừa hết thời gian khóa.
     */
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
              $ne: [{ $ifNull: ['$lockedUntil', null] }, null],
            },
            { $lte: ['$lockedUntil', now] },
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

          // Request trong lúc đang khóa không được kéo dài thời gian khóa.
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
                    $gte: ['$failedLoginAttempts', MAX_FAILED_LOGIN_ATTEMPTS],
                  },
                  lockedUntil,
                  '$$REMOVE',
                ],
              },
            },
          },
        ],
        {
          new: true,
          updatePipeline: true,
        },
      )
      .select('+failedLoginAttempts +failedLoginWindowStartedAt +lockedUntil')
      .exec();

    /*
     * Trường hợp nhiều request đồng thời: một request khác có thể đã khóa
     * tài khoản trước khi update này chạy. Chỉ query bổ sung ở race case.
     */
    if (!updatedUser) {
      const currentLock = await this.userModel
        .findOne({
          _id: userId,
          isDeleted: false,
        })
        .select('+lockedUntil')
        .lean()
        .exec();

      return currentLock?.lockedUntil &&
        currentLock.lockedUntil.getTime() > now.getTime()
        ? currentLock.lockedUntil
        : null;
    }

    const activeLockedUntil =
      updatedUser.lockedUntil &&
      updatedUser.lockedUntil.getTime() > now.getTime()
        ? updatedUser.lockedUntil
        : null;

    if (activeLockedUntil) {
      this.logger.warn(
        `Account temporarily locked after repeated login failures: ${userId.toString()}`,
      );
    }

    return activeLockedUntil;
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
    const email = body.email.trim().toLowerCase();
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

  async login(body: LoginDto): Promise<AuthResponse> {
    const email = body.email.trim().toLowerCase();
    const password = body.password;
    const now = new Date();

    const user = await this.userModel
      .findOne({
        email,
        isDeleted: false,
      })
      .select(
        '+password +failedLoginAttempts +failedLoginWindowStartedAt +lockedUntil',
      )
      .exec();

    /*
     * Luôn chạy bcrypt, kể cả email không tồn tại, để giảm chênh lệch
     * thời gian phản hồi có thể bị dùng để dò tài khoản.
     */
    const passwordHash = user?.password ?? DUMMY_PASSWORD_HASH;
    const isPasswordValid = await bcrypt.compare(password, passwordHash);

    if (!user) {
      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    /*
     * Bcrypt đã được chạy trước đó để giảm timing difference.
     * Mọi lần thử trong thời gian khóa đều nhận cùng contract countdown.
     */
    if (this.isLoginLocked(user, now)) {
      this.throwLoginLocked(user.lockedUntil);
    }

    if (!isPasswordValid) {
      const lockedUntil = await this.recordFailedLoginAttempt(user._id, now);

      if (lockedUntil) {
        this.throwLoginLocked(lockedUntil);
      }

      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    this.ensureAccountCanUseAuth(user);

    const accessToken = this.generateToken(user);
    const refreshToken = this.generateRefreshToken(user);
    const refreshTokenHash = await this.hashRefreshToken(refreshToken);

    /*
     * Chỉ cấp phiên nếu tài khoản vẫn chưa bị khóa/xóa trong thời gian
     * bcrypt đang chạy. Đồng thời reset counter và lưu refresh-token hash.
     */
    const authenticatedUser = await this.userModel
      .findOneAndUpdate(
        {
          _id: user._id,
          isDeleted: false,
          status: { $ne: 'banned' },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
        },
        {
          $set: {
            refreshToken: refreshTokenHash,
            failedLoginAttempts: 0,
          },
          $unset: {
            lockedUntil: '',
            failedLoginWindowStartedAt: '',
          },
        },
        {
          new: true,
          runValidators: true,
        },
      )
      .select('+password')
      .exec();

    if (!authenticatedUser) {
      const latestUser = await this.userModel
        .findById(user._id)
        .select('+lockedUntil')
        .exec();

      const latestCheckTime = new Date();

      if (latestUser && this.isLoginLocked(latestUser, latestCheckTime)) {
        this.throwLoginLocked(latestUser.lockedUntil);
      }

      throw new UnauthorizedException(INVALID_LOGIN_MESSAGE);
    }

    this.logger.log(`User logged in: ${authenticatedUser._id.toString()}`);

    return {
      message: 'Đăng nhập thành công',
      access_token: accessToken,
      refresh_token: refreshToken,
      user: this.toPublicUser(authenticatedUser),
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

    return this.toPublicUser(user);
  }

  // BƯỚC 1: Gửi OTP
  async forgotPassword(body: ForgotPasswordDto) {
    const email = body.email.trim().toLowerCase();

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
    const email = body.email.trim().toLowerCase();
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
    const email = body.email.trim().toLowerCase();
    const { otp, newPassword } = body;

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
          '+refreshToken',
        ].join(' '),
      );

    // Kiểm tra user & Kiểm tra thời hạn OTP (3 phút như ông đã set)
    if (
      !user ||
      !user.forgotPasswordExpiry ||
      user.forgotPasswordExpiry < new Date()
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

    const isOtpValid = await this.isOtpMatched(otp, user.forgotPasswordOtp);

    if (!isOtpValid) {
      user.forgotPasswordAttempts = (user.forgotPasswordAttempts ?? 0) + 1;
      await user.save();

      throw new BadRequestException('OTP không hợp lệ');
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.password);

    if (isSamePassword) {
      /*
       * OTP đã đúng nhưng mật khẩu mới không hợp lệ về mặt nghiệp vụ.
       * Không xóa OTP ở nhánh này để user có thể nhập mật khẩu khác
       * trong thời gian OTP còn hiệu lực.
       */
      throw new BadRequestException(
        'Mật khẩu mới không được trùng với mật khẩu hiện tại',
      );
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Xóa dấu vết OTP sau khi đổi thành công
    user.forgotPasswordOtp = undefined;
    user.forgotPasswordExpiry = undefined;
    user.forgotPasswordAttempts = 0;

    // Reset trạng thái khóa vì user đã chứng minh quyền sở hữu qua OTP.
    user.failedLoginAttempts = 0;
    user.failedLoginWindowStartedAt = undefined;
    user.lockedUntil = undefined;

    // Thu hồi mọi phiên cũ sau khi thay đổi mật khẩu.
    user.refreshToken = null;

    await user.save();

    return { success: true, message: 'Đổi mật khẩu thành công!' };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const { currentPassword, newPassword, confirmPassword } = dto;

    if (newPassword !== confirmPassword) {
      throw new BadRequestException('Mật khẩu xác nhận không khớp');
    }

    const user = await this.userModel
      .findOne({
        _id: userId,
        isDeleted: false,
        status: 'active',
      })
      .select('+password +refreshToken')
      .exec();

    if (!user) {
      throw new UnauthorizedException(
        'Tài khoản không tồn tại hoặc đã bị khóa',
      );
    }

    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword,
      user.password,
    );

    if (!isCurrentPasswordValid) {
      throw new UnauthorizedException('Mật khẩu hiện tại không chính xác');
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.password);

    if (isSamePassword) {
      throw new BadRequestException(
        'Mật khẩu mới không được trùng với mật khẩu hiện tại',
      );
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    /*
     * Thu hồi refresh token sau khi đổi mật khẩu.
     * Access token hiện tại vẫn có thể sống đến khi hết hạn ngắn 15 phút,
     * FE cần xóa token local và yêu cầu đăng nhập lại sau response thành công.
     */
    user.refreshToken = null;

    await user.save();

    this.logger.log(`User changed password: ${user._id.toString()}`);

    return {
      success: true,
      message: 'Đổi mật khẩu thành công, vui lòng đăng nhập lại',
    };
  }

  async logout(userId: string) {
    try {
      // 1. Kiểm tra User có tồn tại không (Phòng trường hợp User bị xóa lúc đang đăng nhập)
      const user = await this.userModel
        .findById(userId)
        .select('+refreshToken');

      if (!user) {
        throw new NotFoundException('Người dùng không tồn tại');
      }

      // Clear refresh token
      user.refreshToken = null;
      await user.save();

      return {
        success: true,
        message: 'Đăng xuất thành công!',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;

      throw new InternalServerErrorException(
        'Có lỗi xảy ra trong quá trình xử lý đăng xuất',
      );
    }
  }

  // LÀM MỚI TOKEN
  async refreshToken(refreshToken: string) {
    try {
      // 1. Verify xem token còn hạn không
      const decoded = this.jwtService.verify<RefreshTokenPayload>(refreshToken);

      // 2. Tìm user và check xem token có khớp DB không (Chống thu hồi)
      const user = await this.userModel
        .findById(decoded.sub)
        .select('+refreshToken')
        .exec();

      const isTokenMatched = await this.isRefreshTokenMatched(
        refreshToken,
        user?.refreshToken,
      );

      if (!user || !isTokenMatched) {
        throw new UnauthorizedException(
          'Refresh token không hợp lệ hoặc đã bị thu hồi',
        );
      }

      this.ensureAccountCanUseAuth(user);

      // 3. Cấp cặp token mới để liên tục cuốn chiếu (Refresh Token Rotation)
      const new_access_token = this.generateToken(user);
      const new_refresh_token = this.generateRefreshToken(user);

      // 4. Update DB
      user.refreshToken = await this.hashRefreshToken(new_refresh_token);
      await user.save();

      return {
        access_token: new_access_token,
        refresh_token: new_refresh_token,
      };
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) throw err;

      this.logger.warn(
        'Refresh token failed',
        err instanceof Error ? err.message : String(err),
      );
      throw new UnauthorizedException(
        'Refresh token không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
      );
    }
  }
}
