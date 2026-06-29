import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RelationshipController } from './controllers/relationship.controller';
import { RelationshipService } from './services/relationship.service';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  Relationship,
  RelationshipSchema,
} from './schemas/relationship.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Block, BlockSchema } from './schemas/block.schema';

@Module({
  // Import cả schema User và Relationship để Service có thể truy vấn cả hai
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([
      { name: Relationship.name, schema: RelationshipSchema },
      { name: User.name, schema: UserSchema },
      { name: Block.name, schema: BlockSchema },
    ]),
  ],
  controllers: [RelationshipController],
  providers: [RelationshipService],
  exports: [RelationshipService], // Xuất ra để các module khác (như Posts) có thể dùng nếu cần
})
export class RelationshipModule {}
