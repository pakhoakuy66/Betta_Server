import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly configService: ConfigService) {
    // Khởi tạo Transporter bắt thông số từ biến môi trường (.env)
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('MAIL_HOST', 'smtp.gmail.com'),
      port: this.configService.get<number>('MAIL_PORT', 587),
      secure: false, // port 587 sử dụng STARTTLS chứ không phải TLS gốc nên secure = false
      auth: {
        user: this.configService.get<string>('MAIL_USER'),
        pass: this.configService.get<string>('MAIL_PASS'),
      },
    });
  }

  /**
   * Cấp phát và Gửi Email OTP cho user
   */
  async sendOtpEmail(to: string, otp: string): Promise<void> {
    try {
      const fromName = this.configService.get<string>('MAIL_FROM') || 'Betta';
      const fromEmail = this.configService.get<string>('MAIL_USER');

      const mailOptions = {
        from: `"${fromName} Support" <${fromEmail}>`,
        to,
        subject: '[Betta] Mã Xác Thực Quên Mật Khẩu (OTP)',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; border: 1px solid #e1e1e1; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
            <h2 style="color: #2c3e50; text-align: center; border-bottom: 2px solid #f4f4f4; padding-bottom: 15px;">Khôi phục mật khẩu tài khoản</h2>
            <p style="color: #34495e; font-size: 16px;">Chào bạn,</p>
            <p style="color: #34495e; font-size: 16px;">Chúng tôi vừa nhận được yêu cầu đặt lại mật khẩu cho tài khoản liên kết với địa chỉ email này trên ứng dụng <strong>Betta</strong>.</p>
            <p style="color: #34495e; font-size: 16px;">Mã xác thực (OTP) của bạn là:</p>
            
            <!-- Box mã OTP -->
            <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 8px; margin: 25px 0; border: 1px dashed #ced4da;">
              <strong style="font-size: 32px; color: #e74c3c; letter-spacing: 8px;">${otp}</strong>
            </div>

            <p style="color: #7f8c8d; font-size: 14px; font-weight: bold;">⚠️ Lưu ý: Mã này chỉ có hiệu lực trong vòng 3 phút.</p>
            <p style="color: #7f8c8d; font-size: 14px;">Tuyệt đối KHÔNG chia sẻ mã này cho bất kỳ ai để đảm bảo an toàn cho tài khoản của bạn.</p>
            
            <hr style="border: 0; border-top: 1px solid #ececec; margin: 30px 0;" />
            <p style="font-size: 12px; color: #bdc3c7; text-align: center;">Nếu bạn không yêu cầu thao tác này, vui lòng bỏ qua email này hoặc liên hệ bộ phận hỗ trợ của Betta ngay lập tức.</p>
          </div>
        `,
      };

      await this.transporter.sendMail(mailOptions);
      this.logger.log(`✅ [MailService] Đã gửi OTP thành công tới: ${to}`);
    } catch (error) {
      this.logger.error(`❌ [MailService] Lỗi gửi email tới ${to}:`, error.stack);
      // Enterprise Note: Chỉ log lại để điều tra, KHÔNG throw error làm hỏng (crash) luồng response API của hệ thống
    }
  }
}
