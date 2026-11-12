import { Global, Module } from '@nestjs/common';
import { SseStreamService } from './sse-stream.service.js';
import { TaskEventsService } from './task-events.service.js';

@Global()
@Module({
  providers: [TaskEventsService, SseStreamService],
  exports: [TaskEventsService, SseStreamService],
})
export class EventsModule {}
