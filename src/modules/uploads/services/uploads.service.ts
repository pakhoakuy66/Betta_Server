import {
  Logger,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

export type UploadedImage = {
  url: string;
  publicId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
};

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'object' && error !== null) {
      return JSON.stringify(error);
    }

    return String(error);
  }

  constructor(private readonly configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.getOrThrow<string>(
        'CLOUDINARY_CLOUD_NAME',
      ),
      api_key: this.configService.getOrThrow<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.getOrThrow<string>(
        'CLOUDINARY_API_SECRET',
      ),
      secure: true,
    });
  }

  async uploadPostImage(file: UploadFile): Promise<UploadedImage> {
    this.validateImageFile(file);

    const result = await this.uploadBuffer(file.buffer, 'betta/posts');

    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    };
  }

  async uploadPostImages(files: UploadFile[] = []): Promise<UploadedImage[]> {
    if (files.length > 3) {
      throw new BadRequestException('Bài viết chỉ được phép có tối đa 3 ảnh');
    }

    return Promise.all(files.map((file) => this.uploadPostImage(file)));
  }

  async deleteImage(publicId: string): Promise<void> {
    if (!publicId) return;

    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: 'image',
        invalidate: true,
      });

      if (result.result !== 'ok' && result.result !== 'not found') {
        this.logger.warn(
          `Unexpected Cloudinary delete result for ${publicId}: ${result.result}`,
        );
      }
    } catch (err: unknown) {
      // Không throw để tránh làm hỏng flow xóa post nếu Cloudinary lỗi tạm thời.
      // Sau này có thể thay bằng logger hoặc retry queue.
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;

      this.logger.warn(
        `Failed to delete image ${publicId} from Cloudinary: ${message}`,
        stack,
      );
    }
  }

  async deleteImages(publicIds: string[]): Promise<void> {
    await Promise.all(publicIds.map((publicId) => this.deleteImage(publicId)));
  }

  private validateImageFile(file: UploadFile): void {
    if (!file?.buffer) {
      throw new BadRequestException('File ảnh không hợp lệ');
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP');
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      throw new BadRequestException('Ảnh không được vượt quá 5MB');
    }
  }

  private uploadBuffer(
    buffer: Buffer,
    folder: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          overwrite: false,
          unique_filename: true,
          use_filename: false,
        },
        (error, result) => {
          if (error || !result) {
            const message = this.getErrorMessage(error);

            this.logger.error(
              `Cloudinary upload failed: ${message}`,
              error instanceof Error ? error.stack : undefined,
            );

            reject(
              new InternalServerErrorException(
                'Upload ảnh thất bại, vui lòng thử lại',
              ),
            );
            return;
          }

          resolve(result);
        },
      );

      uploadStream.on('error', (error: Error) => {
        this.logger.error(
          `Cloudinary upload stream failed: ${error.message}`,
          error.stack,
        );

        reject(
          new InternalServerErrorException(
            'Upload ảnh thất bại, vui lòng thử lại',
          ),
        );
      });

      Readable.from(buffer)
        .on('error', (error: Error) => {
          this.logger.error(
            `Read image buffer failed: ${error.message}`,
            error.stack,
          );

          reject(
            new InternalServerErrorException(
              'Upload ảnh thất bại, vui lòng thử lại',
            ),
          );
        })
        .pipe(uploadStream);
    });
  }
}
