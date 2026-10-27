import type {
  CreateLayerObjectPayload,
  CreateLayerPayload,
  ImageAsset,
  ImageLayer,
  ImageStatusResponse,
  LayerObject,
  OverlayAsset,
  PaginationMeta,
  UpdateLayerObjectPayload,
  UpdateLayerPayload,
} from '@deep-zoom/shared-types';
import { deleteResource, getJson, getPaginated, patchJson, postForm, postJson } from '@/lib/http';

export interface ImageListResult {
  data: ImageAsset[];
  meta: PaginationMeta;
}

/* --------------------------------- images -------------------------------- */

export async function fetchImages(page = 1, limit = 20): Promise<ImageListResult> {
  return getPaginated<ImageAsset>(`/images?page=${page}&limit=${limit}`);
}

export async function fetchImage(imageId: string): Promise<ImageAsset> {
  return getJson<ImageAsset>(`/images/${imageId}`);
}

export async function fetchImageStatus(imageId: string): Promise<ImageStatusResponse> {
  return getJson<ImageStatusResponse>(`/images/${imageId}/status`);
}

export async function uploadImage(file: File, name?: string): Promise<ImageAsset> {
  const form = new FormData();
  form.append('file', file);
  const query = name && name.trim().length > 0 ? `?name=${encodeURIComponent(name.trim())}` : '';
  return postForm<ImageAsset>(`/images${query}`, form);
}

export async function deleteImage(imageId: string): Promise<void> {
  await deleteResource(`/images/${imageId}`);
}

export async function uploadOverlay(imageId: string, file: File): Promise<OverlayAsset> {
  const form = new FormData();
  form.append('file', file);
  return postForm<OverlayAsset>(`/images/${imageId}/overlays`, form);
}

/* --------------------------------- layers -------------------------------- */

export async function fetchLayers(imageId: string): Promise<ImageLayer[]> {
  return getJson<ImageLayer[]>(`/images/${imageId}/layers`);
}

export async function createLayer(imageId: string, payload: CreateLayerPayload): Promise<ImageLayer> {
  return postJson<ImageLayer>(`/images/${imageId}/layers`, payload);
}

export async function updateLayer(layerId: string, payload: UpdateLayerPayload): Promise<ImageLayer> {
  return patchJson<ImageLayer>(`/layers/${layerId}`, payload);
}

export async function deleteLayer(layerId: string): Promise<void> {
  await deleteResource(`/layers/${layerId}`);
}

/* ------------------------------ layer objects ---------------------------- */

export async function fetchLayerObjects(layerId: string): Promise<LayerObject[]> {
  return getJson<LayerObject[]>(`/layers/${layerId}/objects`);
}

export async function createLayerObject(
  layerId: string,
  payload: CreateLayerObjectPayload,
): Promise<LayerObject> {
  return postJson<LayerObject>(`/layers/${layerId}/objects`, payload);
}

export async function updateLayerObject(
  objectId: string,
  payload: UpdateLayerObjectPayload,
): Promise<LayerObject> {
  return patchJson<LayerObject>(`/layer-objects/${objectId}`, payload);
}

export async function deleteLayerObject(objectId: string): Promise<void> {
  await deleteResource(`/layer-objects/${objectId}`);
}

export async function reorderLayerObjects(
  layerId: string,
  orderedObjectIds: string[],
): Promise<LayerObject[]> {
  return patchJson<LayerObject[]>(`/layers/${layerId}/objects/order`, { orderedObjectIds });
}
