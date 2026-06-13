import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { MailService } from './mail.service';
import { generateUserPublicId } from '../../users/utils/generate-public-id';
import { User } from '../../users/schemas/user.schema';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
} from '../dto/auth.dto';
import {
  AuthResponse,
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

  private toPublicUser(user: User) {
    return {
      id: user._id.toString(),
      publicId: user.publicId,
      username: user.username,
      fullname: user.fullname,
      email: user.email,
      phone: user.phone,
      avatar: user.avatar ?? null,
      streakCount: user.streakCount ?? 0,
      status: user.status ?? 'active',
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

  private generateOtpCode(): string {
    // crypto.randomInt phù hợp hơn Math.random cho OTP bảo mật.
    return randomInt(100000, 1000000).toString();
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

    const user = await this.userModel
      .findOne({ email, isDeleted: false })
      .select('+password')
      .exec();

    const DUMMY_HASH =
      '$2b$12$CwTycUXWue0Thq9StjUM0uJ8xgOguJdyQh7fXxH4ILhYo8sHpItCu';
    const passwordToCheck = user?.password ?? DUMMY_HASH;
    const isPasswordValid = await bcrypt.compare(password, passwordToCheck);

    if (!user || !isPasswordValid) {
      throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
    }

    this.ensureAccountCanUseAuth(user);

    const access_token = this.generateToken(user);

    // Tạo Refresh Token sống dài (7 ngày)
    const refresh_token = this.generateRefreshToken(user);

    // Chỉ lưu hash refresh token trong DB. Token raw chỉ trả về client.
    user.refreshToken = await this.hashRefreshToken(refresh_token);
    await user.save();

    this.logger.log(`User logged in: ${user._id}`);

    return {
      message: 'Đăng nhập thành công',
      access_token,
      refresh_token,
      user: this.toPublicUser(user),
    };
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
      // Chuẩn doanh nghiệp: Trả ra lỗi cụ thể nếu email chưa đăng ký
      throw new NotFoundException(
        'Email này không trùng với email khi đăng ký tài khoản',
      );
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
        const remainingWait = this.OTP_COOLDOWN_SECONDS - secondsPassed;
        throw new BadRequestException(
          `Vui lòng đợi ${remainingWait} giây nữa trước khi yêu cầu mã mới`,
        );
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
    } catch (error) {
      this.logger.error('Send OTP mail failed', error);
      throw new InternalServerErrorException(
        'Không thể gửi email OTP. Vui lòng thử lại sau.',
      );
    } 

    return { success: true, message: 'Mã OTP đã được gửi' };
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
        '+password +forgotPasswordOtp +forgotPasswordExpiry +forgotPasswordAttempts',
      );

    if (!user) throw new BadRequestException('Người dùng không tồn tại');

    // Kiểm tra thời hạn OTP (3 phút như ông đã set)
    if (user.forgotPasswordExpiry && user.forgotPasswordExpiry < new Date()) {
      throw new BadRequestException(
        'Mã OTP đã hết hạn, vui lòng yêu cầu mã mới',
      );
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

    // Hash mật khẩu mới (BCRYPT_ROUNDS = 12 như cũ của ông)
    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Xóa dấu vết OTP sau khi đổi thành công
    user.forgotPasswordOtp = undefined;
    user.forgotPasswordExpiry = undefined;
    user.forgotPasswordAttempts = 0;

    await user.save();

    return { success: true, message: 'Đổi mật khẩu thành công!' };
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
