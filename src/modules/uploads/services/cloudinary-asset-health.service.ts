import { Injectable } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';

const CLOUDINARY_IDS_PER_REQUEST = 100;

@Injectable()
export class CloudinaryAssetHealthService {
  /**
   * Trả về đúng các publicId không còn được Cloudinary liệt kê. Lỗi auth,
   * quota, timeout hoặc network được propagate để retention fail closed;
   * caller tuyệt đối không được diễn giải lỗi hạ tầng thành evidence đã mất.
   */
  async findMissingImagePublicIds(
    publicIds: readonly string[],
  ): Promise<string[]> {
    const uniquePublicIds = [
      ...new Set(publicIds.map((value) => value.trim()).filter(Boolean)),
    ];
    const existing = new Set<string>();

    for (
      let offset = 0;
      offset < uniquePublicIds.length;
      offset += CLOUDINARY_IDS_PER_REQUEST
    ) {
      const batch = uniquePublicIds.slice(
        offset,
        offset + CLOUDINARY_IDS_PER_REQUEST,
      );
      const response = await cloudinary.api.resources_by_ids(batch, {
        resource_type: 'image',
        type: 'upload',
        max_results: CLOUDINARY_IDS_PER_REQUEST,
      });

      for (const resource of response.resources ?? []) {
        if (typeof resource.public_id === 'string') {
          existing.add(resource.public_id);
        }
      }
    }

    return uniquePublicIds.filter((publicId) => !existing.has(publicId));
  }
}
