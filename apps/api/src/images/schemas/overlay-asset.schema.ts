import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type OverlayAssetDocument = HydratedDocument<OverlayAsset>;

/**
 * A PNG/WebP bitmap uploaded separately and referenced by IMAGE layer objects.
 * The file is stored on disk; only safe metadata is persisted here.
 */
@Schema({ collection: 'overlay_assets', timestamps: true, versionKey: false })
export class OverlayAsset {
  @Prop({ type: Types.ObjectId, ref: 'ImageAsset', required: true, index: true })
  imageAssetId!: Types.ObjectId;

  @Prop({ type: String, required: true, unique: true })
  storageKey!: string;

  @Prop({ type: String, required: true, enum: ['image/png', 'image/webp', 'image/jpeg'] })
  mimeType!: string;

  @Prop({ type: String, required: true, enum: ['png', 'webp', 'jpg'] })
  extension!: string;

  @Prop({ type: Number, required: true, min: 1 })
  width!: number;

  @Prop({ type: Number, required: true, min: 1 })
  height!: number;

  @Prop({ type: Number, required: true, min: 1 })
  fileSize!: number;

  @Prop({ type: String, required: true, maxlength: 255 })
  originalFilename!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const OverlayAssetSchema = SchemaFactory.createForClass(OverlayAsset);

OverlayAssetSchema.index({ imageAssetId: 1, createdAt: -1 });
