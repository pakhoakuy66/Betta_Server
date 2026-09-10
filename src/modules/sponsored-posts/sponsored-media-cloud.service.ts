import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
@Injectable()
export class SponsoredMediaCloudService {
  constructor(private readonly config: ConfigService) {}
  private settings() {
    const environment = this.config.get<string>('SPONSORED_MEDIA_ENV');
    if (
      !environment ||
      !['development', 'staging', 'production', 'test'].includes(environment)
    )
      throw new ServiceUnavailableException('SPONSORED_MEDIA_CONFIG_MISSING');
    return {
      environment,
      cloud_name: this.config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.getOrThrow<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
      timeout: 10_000,
    };
  }
  remoteId(id: string): string {
    if (!/^sma_[a-f0-9]{32}$/.test(id))
      throw new Error('SPONSORED_ASSET_ID_INVALID');
    return `betta/${this.settings().environment}/sponsored/${id}`;
  }
  private options(remoteId: string) {
    const settings = this.settings();
    const prefix = `betta/${settings.environment}/sponsored/`;
    if (
      !remoteId.startsWith(prefix) ||
      !/^sma_[a-f0-9]{32}$/.test(remoteId.slice(prefix.length))
    )
      throw new Error('SPONSORED_ASSET_SCOPE_INVALID');
    return settings;
  }
  async upload(remoteId: string, bytes: Buffer): Promise<string> {
    const options = this.options(remoteId);
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          ...options,
          public_id: remoteId,
          resource_type: 'image',
          type: 'upload',
          overwrite: false,
          format: 'webp',
          unique_filename: false,
        },
        (error, response) => {
          if (error || !response) reject(new Error('SPONSORED_UPLOAD_FAILED'));
          else resolve(response);
        },
      );
      stream.on('error', () => reject(new Error('SPONSORED_UPLOAD_FAILED')));
      stream.end(bytes);
    });
    const url = new URL(result.secure_url);
    if (
      result.public_id !== remoteId ||
      result.format !== 'webp' ||
      url.protocol !== 'https:' ||
      url.hostname !== 'res.cloudinary.com' ||
      !url.pathname.startsWith(`/${options.cloud_name}/image/upload/`)
    )
      throw new Error('SPONSORED_UPLOAD_RESPONSE_INVALID');
    return result.secure_url;
  }
  async destroy(remoteId: string): Promise<void> {
    const result = (await cloudinary.uploader.destroy(remoteId, {
      ...this.options(remoteId),
      resource_type: 'image',
      type: 'upload',
      invalidate: true,
    })) as { result?: string };
    if (!['ok', 'not found'].includes(result.result ?? ''))
      throw new Error('SPONSORED_CLEANUP_FAILED');
  }
  async health(remoteId: string): Promise<'healthy' | 'missing' | 'corrupt'> {
    try {
      const value = (await cloudinary.api.resource(remoteId, {
        ...this.options(remoteId),
        resource_type: 'image',
        type: 'upload',
      })) as {
        public_id?: string;
        format?: string;
        width?: number;
        height?: number;
      };
      return value.public_id === remoteId &&
        value.format === 'webp' &&
        (value.width ?? 0) >= 64 &&
        (value.height ?? 0) >= 64
        ? 'healthy'
        : 'corrupt';
    } catch (error: unknown) {
      if (
        (error as { error?: { http_code?: number }; http_code?: number })?.error
          ?.http_code === 404 ||
        (error as { http_code?: number })?.http_code === 404
      )
        return 'missing';
      throw new ServiceUnavailableException('SPONSORED_HEALTH_UNAVAILABLE');
    }
  }
}
