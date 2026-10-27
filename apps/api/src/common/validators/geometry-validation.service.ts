import { Injectable } from '@nestjs/common';
import {
  ImageOverlayGeometry,
  ImagePoint,
  LabelGeometry,
  LayerGeometry,
  LayerObjectType,
  PointGeometry,
  PolygonGeometry,
  RectangleGeometry,
} from '@deep-zoom/shared-types';
import { ApplicationError } from '../errors/application.error';

export interface GeometryBounds {
  width: number;
  height: number;
}

const MAX_POLYGON_POINTS = 2000;
const MAX_COORDINATE = 1_000_000;
/** Tolerance in image pixels allowed when checking coordinates against image bounds. */
const BOUNDS_TOLERANCE = 1.5;

export class GeometryValidationError extends Error {}

function fail(message: string): never {
  throw new GeometryValidationError(message);
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${label} contains unsupported property "${key}"`);
    }
  }
}

function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  if (Math.abs(value) > MAX_COORDINATE) {
    fail(`${label} must be within ±${MAX_COORDINATE}`);
  }
  return value;
}

function assertNonNegative(value: unknown, label: string): number {
  const num = assertFiniteNumber(value, label);
  if (num < 0) {
    fail(`${label} must be greater than or equal to 0`);
  }
  return num;
}

function isPointLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the discriminated union of layer-object geometries.
 *
 * The API stores geometry in original-image pixel coordinates, so every value
 * must be a finite, non-negative number inside the image bounds. Unknown keys
 * are rejected so that arbitrary blobs cannot be persisted through `geometry`.
 */
@Injectable()
export class GeometryValidationService {
  /**
   * Validates `raw` for the given object type and returns a normalized geometry
   * object containing only known properties.
   */
  parse(
    type: LayerObjectType,
    raw: unknown,
    bounds?: GeometryBounds,
  ): LayerGeometry {
    const geometry = assertPlainObject(raw, 'geometry');

    let normalized: LayerGeometry;
    switch (type) {
      case 'POLYGON':
        normalized = this.parsePolygon(geometry);
        break;
      case 'RECTANGLE':
        normalized = this.parseRectangle(geometry);
        break;
      case 'POINT':
        normalized = this.parsePoint(geometry);
        break;
      case 'LABEL':
        normalized = this.parsePoint(geometry);
        break;
      case 'IMAGE':
        normalized = this.parseImageOverlay(geometry);
        break;
      default:
        fail(`Unsupported object type "${String(type)}"`);
    }

    if (bounds) {
      this.assertWithinBounds(normalized, bounds);
    }

    return normalized;
  }

  /**
   * Bounds-check used by the service layer once the image dimensions are known.
   */
  assertWithinBounds(geometry: LayerGeometry, bounds: GeometryBounds): void {
    const { width, height } = bounds;
    if (!(width > 0) || !(height > 0)) {
      return;
    }
    const maxX = width + BOUNDS_TOLERANCE;
    const maxY = height + BOUNDS_TOLERANCE;

    const checkPoint = (point: ImagePoint, label: string): void => {
      if (point.x > maxX || point.y > maxY) {
        fail(
          `${label} (${point.x}, ${point.y}) lies outside the image bounds ${width}x${height}`,
        );
      }
    };

    const points = this.collectPoints(geometry);
    points.forEach((point, index) => checkPoint(point, `point[${index}]`));

    if ('width' in geometry && 'height' in geometry) {
      const g = geometry;
      if (g.x + g.width > maxX + BOUNDS_TOLERANCE || g.y + g.height > maxY + BOUNDS_TOLERANCE) {
        fail(
          `geometry extends past the image bounds ${width}x${height}`,
        );
      }
    }
  }

  private collectPoints(geometry: LayerGeometry): ImagePoint[] {
    if ('points' in geometry) {
      return geometry.points;
    }
    return [{ x: geometry.x, y: geometry.y }];
  }

  private parsePolygon(raw: Record<string, unknown>): PolygonGeometry {
    assertNoUnknownKeys(raw, ['points'], 'geometry');
    const points = raw.points;
    if (!Array.isArray(points)) {
      fail('geometry.points must be an array');
    }
    if (points.length < 3) {
      fail('geometry.points must contain at least 3 points');
    }
    if (points.length > MAX_POLYGON_POINTS) {
      fail(`geometry.points must contain at most ${MAX_POLYGON_POINTS} points`);
    }

    return {
      points: points.map((point, index) => {
        if (!isPointLike(point)) {
          fail(`geometry.points[${index}] must be an object with x and y`);
        }
        assertNoUnknownKeys(point, ['x', 'y'], `geometry.points[${index}]`);
        return {
          x: assertNonNegative(point.x, `geometry.points[${index}].x`),
          y: assertNonNegative(point.y, `geometry.points[${index}].y`),
        };
      }),
    };
  }

  private parseRectangle(raw: Record<string, unknown>): RectangleGeometry {
    assertNoUnknownKeys(raw, ['x', 'y', 'width', 'height'], 'geometry');
    const geometry: RectangleGeometry = {
      x: assertNonNegative(raw.x, 'geometry.x'),
      y: assertNonNegative(raw.y, 'geometry.y'),
      width: assertFiniteNumber(raw.width, 'geometry.width'),
      height: assertFiniteNumber(raw.height, 'geometry.height'),
    };
    if (geometry.width <= 0 || geometry.height <= 0) {
      fail('geometry.width and geometry.height must be greater than 0');
    }
    return geometry;
  }

  private parsePoint(raw: Record<string, unknown>): PointGeometry | LabelGeometry {
    assertNoUnknownKeys(raw, ['x', 'y'], 'geometry');
    return {
      x: assertNonNegative(raw.x, 'geometry.x'),
      y: assertNonNegative(raw.y, 'geometry.y'),
    } satisfies PointGeometry | LabelGeometry;
  }

  private parseImageOverlay(raw: Record<string, unknown>): ImageOverlayGeometry {
    assertNoUnknownKeys(raw, ['x', 'y', 'width', 'height', 'overlayId'], 'geometry');
    const overlayId = raw.overlayId;
    if (typeof overlayId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(overlayId)) {
      fail('geometry.overlayId must be a valid ObjectId string');
    }
    const geometry: ImageOverlayGeometry = {
      x: assertNonNegative(raw.x, 'geometry.x'),
      y: assertNonNegative(raw.y, 'geometry.y'),
      width: assertFiniteNumber(raw.width, 'geometry.width'),
      height: assertFiniteNumber(raw.height, 'geometry.height'),
      overlayId,
    };
    if (geometry.width <= 0 || geometry.height <= 0) {
      fail('geometry.width and geometry.height must be greater than 0');
    }
    return geometry;
  }
}

/** Helper used by services to rethrow as a proper HTTP error. */
export function toGeometryApplicationError(error: unknown): unknown {
  if (error instanceof GeometryValidationError) {
    return ApplicationError.badRequest('INVALID_GEOMETRY', error.message);
  }
  return error;
}
