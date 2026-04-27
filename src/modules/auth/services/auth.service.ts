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
import { MailService } from './mail.service';
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

// ─────────────────────────────────────────────
// Helper: ép kiểu err unknown → MongoError shape
// Dùng chung cho mọi catch block trong project
// ─────────────────────────────────────────────
interface MongoError {
  code?: number;
  stack?: string;
  message?: string;
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

  // Cấu hình hằng số chuẩn
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

  private toPublicUser(user: User) {
    return {
      _id: user._id.toString(),
      username: user.username,
      fullname: user.fullname,
      avatar: user.avatar ?? null,
      streakCount: user.streakCount ?? 0,
    };
  }

  // ─────────────────────────────────────────────
  // REGISTER
  // ─────────────────────────────────────────────

  async register(body: RegisterDto): Promise<RegisterResponse> {
    const { username, fullname, phone, email, password } = body;

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
      await this.userModel.create({
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
    const { email, password } = body;

    const user = await this.userModel
      .findOne({ email, isDeleted: false })
      .select('+password')
      .exec();

    const DUMMY_HASH =
      '$2b$12$invalidhashfortimingattackprevention000000000000000';
    const passwordToCheck = user?.password ?? DUMMY_HASH;
    const isPasswordValid = await bcrypt.compare(password, passwordToCheck);

    if (!user || !isPasswordValid) {
      throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
    }

    const access_token = this.generateToken(user);
    
    // Tạo Refresh Token sống dài (7 ngày)
    const refresh_token = this.jwtService.sign(
      { sub: user._id },
      { expiresIn: '7d' },
    );

    // Lưu vào DB
    user.refreshToken = refresh_token;
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
    const user = await this.userModel
      .findOne({
        email: body.email,
        isDeleted: false,
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
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Lưu OTP vào DB với thời hạn 3 phút (Standard)
    user.forgotPasswordOtp = otp;
    user.forgotPasswordExpiry = new Date(
      Date.now() + this.OTP_EXPIRY_MINUTES * 60 * 1000,
    );
    await user.save();

    // Gửi email (Giả sử ông đã có MailService, nếu chưa thì log ra console để test)
    this.logger.log(`OTP cho ${body.email} là: ${otp}`);
    // Gửi email thật cho User thay vì log console
    this.mailService.sendOtpEmail(body.email, otp);

    // Test OTP
    console.log('EMAIL:', body.email);
    console.log('MÃ OTP MỚI:', otp);

    return { success: true, message: 'Mã OTP đã được gửi' };
  }

  // BƯỚC 2: Verify OTP
  async verifyOtp(body: VerifyOtpDto) {
    const user = await this.userModel
      .findOne({
        email: body.email,
        forgotPasswordOtp: body.otp,
        isDeleted: false,
      })
      .select('+forgotPasswordExpiry');

    if (
      !user ||
      (user.forgotPasswordExpiry && user.forgotPasswordExpiry < new Date())
    ) {
      throw new UnauthorizedException('OTP sai hoặc đã hết hạn');
    }

    return { success: true, message: 'OTP hợp lệ' };
  }

  // BƯỚC 3: Đổi mật khẩu mới
  async resetPassword(body: ResetPasswordDto) {
    const { email, otp, newPassword } = body;

    const user = await this.userModel
      .findOne({
        email: body.email,
        forgotPasswordOtp: otp,
        isDeleted: false,
      })
      .select('+password +forgotPasswordOtp +forgotPasswordExpiry');

    if (!user) throw new BadRequestException('Người dùng không tồn tại');

    // Kiểm tra thời hạn OTP (3 phút như ông đã set)
    if (user.forgotPasswordExpiry && user.forgotPasswordExpiry < new Date()) {
      throw new BadRequestException(
        'Mã OTP đã hết hạn, vui lòng yêu cầu mã mới',
      );
    }

    // Hash mật khẩu mới (BCRYPT_ROUNDS = 12 như cũ của ông)
    const salt = await bcrypt.genSalt(12);
    user.password = await bcrypt.hash(body.newPassword, salt);

    // Xóa dấu vết OTP sau khi đổi thành công
    user.forgotPasswordOtp = undefined;
    user.forgotPasswordExpiry = undefined;

    await user.save();

    return { success: true, message: 'Đổi mật khẩu thành công!' };
  }

  async logout(userId: string) {
    try {
      // 1. Kiểm tra User có tồn tại không (Phòng trường hợp User bị xóa lúc đang đăng nhập)
      const user = await this.userModel.findById(userId);
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
      const decoded = this.jwtService.verify(refreshToken);
      
      // 2. Tìm user và check xem token có khớp DB không (Chống thu hồi)
      const user = await this.userModel.findById(decoded.sub);
      if (!user || user.refreshToken !== refreshToken || user.isDeleted) {
        throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã bị thu hồi');
      }

      // 3. Cấp cặp token mới để liên tục cuốn chiếu (Refresh Token Rotation)
      const new_access_token = this.generateToken(user);
      const new_refresh_token = this.jwtService.sign(
        { sub: user._id },
        { expiresIn: '7d' },
      );

      // 4. Update DB
      user.refreshToken = new_refresh_token;
      await user.save();

      return {
        access_token: new_access_token,
        refresh_token: new_refresh_token,
      };
    } catch (err) {
      throw new UnauthorizedException('Refresh token không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.');
    }
  }
}
