import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';
import { ADMIN_LIFECYCLE_COORDINATOR_KEY } from '../constants/admin-lifecycle.constants';

export const ADMIN_LIFECYCLE_COORDINATOR_COLLECTION =
  'admin_lifecycle_coordinators';
export const ADMIN_LIFECYCLE_COORDINATOR_KEY_INDEX =
  'admin_lifecycle_coordinators_key_unique';

const isNonNegativeSafeInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0;

@Schema({
  collection: ADMIN_LIFECYCLE_COORDINATOR_COLLECTION,
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class AdminLifecycleCoordinator {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: [ADMIN_LIFECYCLE_COORDINATOR_KEY],
  })
  key!: typeof ADMIN_LIFECYCLE_COORDINATOR_KEY;

  @Prop({
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: { validator: isNonNegativeSafeInteger },
  })
  revision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminLifecycleCoordinatorDocument =
  HydratedDocument<AdminLifecycleCoordinator>;

export const AdminLifecycleCoordinatorSchema = SchemaFactory.createForClass(
  AdminLifecycleCoordinator,
);

AdminLifecycleCoordinatorSchema.index(
  { key: 1 },
  { name: ADMIN_LIFECYCLE_COORDINATOR_KEY_INDEX, unique: true },
);
