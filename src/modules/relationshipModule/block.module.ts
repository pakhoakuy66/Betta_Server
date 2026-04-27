import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Block, BlockSchema } from './schemas/block.schema';
import { BlockController } from './controllers/block.controller';
import { BlockService } from './services/block.service';
import { RelationshipModule } from './relationship.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Block.name, schema: BlockSchema }]),
    RelationshipModule, // Import để có thể xài ké hàm unfollow của module bên kia
  ],
  controllers: [BlockController],
  providers: [BlockService],
})
export class BlockModule {}
