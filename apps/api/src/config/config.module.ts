import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { APP_CONFIG, AppConfig, loadConfig } from './configuration';

/**
 * Loads `.env` once and exposes the validated {@link AppConfig} through DI.
 * Global because nearly every module needs the storage directory or a limit.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Resolved against the API working directory (apps/api) or the repo root.
      envFilePath: ['.env', '../../.env'],
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
