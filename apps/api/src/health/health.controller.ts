import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @ApiOperation({ summary: 'Liveness and database connectivity check' })
  check(): { status: string; database: string; uptimeSeconds: number } {
    const readyState = this.connection.readyState;
    // 1 === connected (mongoose ConnectionStates.connected)
    const connected = readyState === (1 as typeof readyState);
    return {
      status: connected ? 'ok' : 'degraded',
      database: connected ? 'connected' : 'disconnected',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
