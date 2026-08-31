import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { OutboxEvent, OutboxEventSchema } from './outbox-event.schema';
import { OutboxHandlerRegistry } from './outbox-handler.registry';
import { OutboxProcessorService } from './outbox-processor.service';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: OutboxEvent.name, schema: OutboxEventSchema },
    ]),
  ],
  providers: [OutboxService, OutboxHandlerRegistry, OutboxProcessorService],
  exports: [OutboxService, OutboxHandlerRegistry],
})
export class OutboxModule {}
