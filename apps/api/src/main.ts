import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/configuration';
import { configureSharpCache } from './common/sharp/sharp-cache';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // Must run before any Sharp call so libvips never keeps a file handle open
  // (which makes the file undeletable on Windows).
  configureSharpCache();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });

  const config = app.get<AppConfig>(APP_CONFIG);

  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: [config.frontendOrigin],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    credentials: false,
    maxAge: 86400,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Deep Zoom Layer Editor API')
    .setDescription(
      'Upload images, generate Deep Zoom pyramids, serve tiles and manage layers/objects in original-image pixel coordinates.',
    )
    .setVersion('1.0')
    .addTag('images')
    .addTag('layers')
    .addTag('layer-objects')
    .addTag('health')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(config.port, '0.0.0.0');
  logger.log(`API listening on http://localhost:${config.port}/api/v1`);
  logger.log(`Swagger UI at http://localhost:${config.port}/api/docs`);
  logger.log(`Storage directory: ${config.storageDir}`);
}

void bootstrap();
