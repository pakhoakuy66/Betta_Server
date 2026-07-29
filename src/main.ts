import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { readExactCorsOrigins } from './common/config/exact-origin.config';
import {
  applyTrustProxyConfiguration,
  type TrustProxyApplication,
} from './common/config/trust-proxy.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  const expressApplication = app
    .getHttpAdapter()
    .getInstance() as unknown as TrustProxyApplication;

  applyTrustProxyConfiguration(expressApplication, configService);

  // 1. Kích hoạt Logger (Công cụ ghi chép hệ thống siêu cấp của Nest)
  const logger = new Logger('BettaSystem');

  // --- BỔ SUNG: KIỂM TRA JWT_SECRET (Chuẩn doanh nghiệp) --- DÙNG TẠM THỜI
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret === 'changeme_please_super_secret') {
    logger.error(
      '❌ LỖI NGHIÊM TRỌNG: JWT_SECRET chưa được cấu hình trong file .env!',
    );
    logger.error('Hệ thống sẽ dừng lại để đảm bảo an toàn bảo mật.');
    process.exit(1); // Shutdown ngay lập tức
  }
  // --------------------------------------------------------

  // 2. Kích hoạt CORS để Frontend có thể gọi API (Tránh lỗi chặn Cross-Origin)
  const corsAllowedOrigins = readExactCorsOrigins(configService);

  app.enableCors({
    origin: [...corsAllowedOrigins],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 3. Gắn "Tiền tố" (Prefix) cho toàn bộ API (Chuẩn hóa Versioning)
  // Các API từ giờ sẽ phải gọi dưới dạng: http://localhost:5000/api/v1/auth/register
  app.setGlobalPrefix('api/v1');

  // --- BỔ SUNG: CẤU HÌNH SWAGGER (Chuẩn doanh nghiệp) ---
  const config = new DocumentBuilder()
    .setTitle('Betta Social Network API')
    .setDescription('Tài liệu API cho hệ thống mạng xã hội Betta - Soundstory')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Nhập Token vào đây',
        in: 'header',
      },
      'access-token', // Tên này phải khớp với bên Controller nếu dùng @ApiBearerAuth()
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  // Đường dẫn xem tài liệu sẽ là: http://localhost:5000/api/v1/docs
  SwaggerModule.setup('api/v1/docs', app, document);

  // 4. Kích hoạt ValidationPipe (Lá chắn thép ngăn ngừa Data rác)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Tự dọn dẹp các field rác gửi thêm không có trong DTO
      forbidNonWhitelisted: true, // Báo lỗi HTTP 400 nếu Hacker cố tình gửi field lạ
      transform: true, // Tự ép kiểu dữ liệu (như chuỗi "1" ở Param thành số 1)
    }),
  );

  // 5. Cấu hình Cổng Mạng (Port)
  const port = process.env.PORT || 5000;
  await app.listen(port);

  // 6. In ra màn hình Terminal bảng báo cáo khởi động chuẩn
  logger.log(`==========================================================`);
  logger.log(`JWT đã sẵn sàng`);
  logger.log(
    `Betta Backend đang bốc cháy tại: http://localhost:${port}/api/v1`,
  );
  logger.log(`Swagger Docs: http://localhost:${port}/api/v1/docs`);
  logger.log(`==========================================================`);
}
void bootstrap();
