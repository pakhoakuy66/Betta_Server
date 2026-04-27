import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Relationship, RelationshipSchema } from './schemas/relationship.schema';
import { RelationshipController } from './controllers/relationship.controller';
import { RelationshipService } from './services/relationship.service';
import { User, UserSchema } from '../users/schemas/user.schema';

@Module({
  // Import cả schema User và Relationship để Service có thể truy vấn cả hai
  imports: [
    MongooseModule.forFeature([
      { name: Relationship.name, schema: RelationshipSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [RelationshipController],
  providers: [RelationshipService],
  exports: [RelationshipService], // Xuất ra để các module khác (như Posts) có thể dùng nếu cần
})
export class RelationshipModule {}
