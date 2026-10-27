/**
 * Pure shared types between the Next.js web app and the NestJS API.
 * This package must never import Mongoose schemas or NestJS decorators.
 */

/** A point in original-image pixel coordinates (origin top-left, y grows downwards). */
export interface ImagePoint {
  x: number;
  y: number;
}

export const IMAGE_STATUS = ['PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type ImageStatus = (typeof IMAGE_STATUS)[number];

export const LAYER_OBJECT_TYPES = [
  'POLYGON',
  'RECTANGLE',
  'POINT',
  'LABEL',
  'IMAGE',
] as const;
export type LayerObjectType = (typeof LAYER_OBJECT_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Geometry (discriminated union, all coordinates in image pixels)     */
/* ------------------------------------------------------------------ */

export interface PolygonGeometry {
  points: ImagePoint[];
}

export interface RectangleGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointGeometry {
  x: number;
  y: number;
}

export interface LabelGeometry {
  x: number;
  y: number;
}

export interface ImageOverlayGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Id of an uploaded overlay asset belonging to the same image asset. */
  overlayId: string;
}

export type LayerGeometry =
  | PolygonGeometry
  | RectangleGeometry
  | PointGeometry
  | LabelGeometry
  | ImageOverlayGeometry;

/* ------------------------------------------------------------------ */
/* Style                                                               */
/* ------------------------------------------------------------------ */

export interface PolygonStyle {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
}

export type RectangleStyle = PolygonStyle;

export interface PointStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
}

export interface LabelStyle {
  color: string;
  fontSize: number;
  fontFamily: string;
  backgroundColor: string;
  backgroundOpacity: number;
}

export interface ImageOverlayStyle {
  opacity: number;
}

export type LayerObjectStyle =
  | PolygonStyle
  | RectangleStyle
  | PointStyle
  | LabelStyle
  | ImageOverlayStyle;

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

export interface LabelMetadata {
  text: string;
}

export interface GenericMetadata {
  name?: string;
  description?: string;
}

export type LayerObjectMetadata = LabelMetadata | GenericMetadata;

/* ------------------------------------------------------------------ */
/* Entities (API representation)                                       */
/* ------------------------------------------------------------------ */

export interface ImageAsset {
  _id: string;
  name: string;
  originalFilename: string;
  width?: number;
  height?: number;
  fileSize: number;
  mimeType: string;
  status: ImageStatus;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImageStatusResponse {
  imageId: string;
  status: ImageStatus;
  errorMessage?: string;
  width?: number;
  height?: number;
  updatedAt: string;
}

export interface ImageLayer {
  _id: string;
  imageAssetId: string;
  name: string;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface LayerObject {
  _id: string;
  layerId: string;
  type: LayerObjectType;
  geometry: LayerGeometry;
  style: LayerObjectStyle;
  metadata: LayerObjectMetadata;
  visible: boolean;
  zIndex: number;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Request payloads                                                    */
/* ------------------------------------------------------------------ */

export interface CreateLayerPayload {
  name: string;
  visible?: boolean;
  locked?: boolean;
  zIndex?: number;
}

export interface UpdateLayerPayload {
  name?: string;
  visible?: boolean;
  locked?: boolean;
  zIndex?: number;
}

export interface CreateLayerObjectPayload {
  type: LayerObjectType;
  geometry: LayerGeometry;
  style?: LayerObjectStyle;
  metadata?: LayerObjectMetadata;
  visible?: boolean;
  zIndex?: number;
}

export interface UpdateLayerObjectPayload {
  geometry?: LayerGeometry;
  style?: LayerObjectStyle;
  metadata?: LayerObjectMetadata;
  visible?: boolean;
  zIndex?: number;
}

export interface ReorderObjectsPayload {
  /** Object ids in their desired ascending zIndex order. */
  orderedObjectIds: string[];
}

export interface OverlayAsset {
  _id: string;
  imageAssetId: string;
  mimeType: string;
  width: number;
  height: number;
  fileSize: number;
  url: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* API envelopes                                                       */
/* ------------------------------------------------------------------ */

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  data: T;
}

export interface PaginatedApiResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string | string[];
  path: string;
  timestamp: string;
}
