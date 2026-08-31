import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from '@jest/globals';
import { AccessSupportSecurityModule } from '../reports/access-support-security.module';
import { ReportsModule } from '../reports/reports.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AdminModule } from './admin.module';

describe('AdminModule access-support dependency boundary', () => {
  it('imports only access-support security and not Reports/Uploads', () => {
    const metadata: unknown = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AdminModule,
    );

    expect(Array.isArray(metadata)).toBe(true);

    const imports = metadata as readonly unknown[];
    expect(imports).toContain(AccessSupportSecurityModule);
    expect(imports).not.toContain(ReportsModule);
    expect(imports).not.toContain(UploadsModule);
  });
});
