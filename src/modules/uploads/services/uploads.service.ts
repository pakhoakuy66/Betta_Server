import {
  Logger,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

type CloudinaryDestroyResult = {
  result?: string;
};

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

type DeleteImageOptions = {
  throwOnError?: boolean;
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

  async uploadAvatar(file: UploadFile): Promise<UploadedImage> {
    this.validateImageFile(file);

    const result = await this.uploadBuffer(file.buffer, 'betta/avatars');

    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    };
  }

  async deleteImage(
    publicId: string,
    options: DeleteImageOptions = {},
  ): Promise<void> {
    if (!publicId) return;

    try {
      const result = (await cloudinary.uploader.destroy(publicId, {
        resource_type: 'image',
        invalidate: true,
      })) as CloudinaryDestroyResult;

      if (result.result !== 'ok' && result.result !== 'not found') {
        const message = `Unexpected Cloudinary delete result for ${publicId}: ${result.result}`;

        this.logger.warn(message);

        if (options.throwOnError) {
          throw new Error(message);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Failed to delete image ${publicId} from Cloudinary: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );

      if (options.throwOnError) {
        throw error;
      }
    }
  }

  async deleteImages(
    publicIds: string[],
    options: DeleteImageOptions = {},
  ): Promise<void> {
    const uniquePublicIds = [...new Set(publicIds.filter(Boolean))];

    if (uniquePublicIds.length === 0) return;

    const results = await Promise.allSettled(
      uniquePublicIds.map((publicId) => this.deleteImage(publicId, options)),
    );

    if (!options.throwOnError) return;

    const failedCount = results.filter(
      (result) => result.status === 'rejected',
    ).length;

    if (failedCount > 0) {
      throw new Error(
        `Failed to delete ${failedCount}/${uniquePublicIds.length} Cloudinary images`,
      );
    }
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
