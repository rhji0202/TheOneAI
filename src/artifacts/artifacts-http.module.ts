import { Module } from '@nestjs/common';
import { ArtifactsAdminController, ArtifactsController } from './artifacts.controller.js';

@Module({ controllers: [ArtifactsController, ArtifactsAdminController] })
export class ArtifactsHttpModule {}
