'use client';

import { useRef, useState } from 'react';
import type {
  ImageOverlayGeometry,
  LabelGeometry,
  LayerGeometry,
  LayerObjectMetadata,
  LayerObjectStyle,
  PointGeometry,
  PolygonGeometry,
  RectangleGeometry,
} from '@deep-zoom/shared-types';
import type { DraftObject } from '@/lib/editor-state';
import { DEFAULT_OBJECT_STYLES } from '@/lib/editor-state';
import { uploadOverlay } from '@/services/api-client';
import { ApiError } from '@/lib/http';
import styles from './properties-panel.module.css';

export interface PropertiesPanelProps {
  object: DraftObject | null;
  imageId: string;
  imageWidth: number;
  imageHeight: number;
  onUpdateGeometry: (geometry: LayerGeometry) => void;
  onUpdateStyle: (patch: Partial<LayerObjectStyle>) => void;
  onUpdateMetadata: (patch: Partial<LayerObjectMetadata>) => void;
  onRemove: () => void;
  onToggleVisibility: () => void;
  onMove: (direction: 'up' | 'down') => void;
  disabled?: boolean;
  /** Notifies the editor that a new overlay asset is available for rendering. */
  onOverlayUploaded: (overlayId: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  POLYGON: 'Đa giác',
  RECTANGLE: 'Hình chữ nhật',
  POINT: 'Điểm',
  LABEL: 'Nhãn chữ',
  IMAGE: 'Ảnh chồng lớp',
};

/**
 * Reshapes a drawn box so it matches the overlay bitmap's aspect ratio.
 *
 * An IMAGE object stores only a rectangle; the overlay is drawn into it. If the
 * rectangle and the bitmap disagree on proportions, the bitmap gets stretched
 * non-uniformly and a detailed image looks torn/smeared. Keeping the drawn
 * width and deriving the height (or vice versa) makes the overlay fill the box
 * exactly as it was authored.
 *
 * The larger of the two drawn dimensions is preserved so the overlay never
 * shrinks away from what the user selected, and the box keeps its top-left
 * anchor.
 */
export function fitGeometryToOverlay(
  geometry: ImageOverlayGeometry,
  overlayWidth: number,
  overlayHeight: number,
  overlayId: string = geometry.overlayId,
): ImageOverlayGeometry {
  if (overlayWidth <= 0 || overlayHeight <= 0) {
    return { ...geometry, overlayId };
  }

  const aspect = overlayWidth / overlayHeight;
  const drawnWidth = Math.max(geometry.width, 1);
  const drawnHeight = Math.max(geometry.height, 1);
  const drawnAspect = drawnWidth / drawnHeight;

  // Derive the missing dimension from whichever drawn side is larger, so the
  // fitted box always covers the user's selection.
  const width = drawnAspect > aspect ? drawnWidth : drawnHeight * aspect;
  const height = drawnAspect > aspect ? drawnWidth / aspect : drawnHeight;

  return {
    ...geometry,
    overlayId,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
  };
}

interface PolygonStyleView {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
}
interface PointStyleView {
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
}
interface LabelStyleView {
  color: string;
  fontSize: number;
  fontFamily: string;
  backgroundColor: string;
  backgroundOpacity: number;
}
interface ImageStyleView {
  opacity: number;
}

/**
 * Fallbacks come from the shared defaults so an unsaved object is editable and
 * renders with exactly the values the API will persist.
 */
const DEFAULT_POLYGON_STYLE = DEFAULT_OBJECT_STYLES.POLYGON as PolygonStyleView;
const DEFAULT_RECTANGLE_STYLE = DEFAULT_OBJECT_STYLES.RECTANGLE as PolygonStyleView;
const DEFAULT_POINT_STYLE = DEFAULT_OBJECT_STYLES.POINT as PointStyleView;
const DEFAULT_LABEL_STYLE = DEFAULT_OBJECT_STYLES.LABEL as LabelStyleView;
const DEFAULT_IMAGE_STYLE = DEFAULT_OBJECT_STYLES.IMAGE as ImageStyleView;

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  // A local draft keeps the field editable while it is being typed into. With
  // a purely controlled value, clearing the field would immediately restore
  // the old number, so the next keystroke would be appended to it instead of
  // replacing it.
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue =
    draft ?? (Number.isFinite(value) ? String(Number(value.toFixed(2))) : '0');

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        value={displayValue}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const parsed = Number.parseFloat(raw);
          if (Number.isFinite(parsed)) {
            onChange(parsed);
          }
        }}
        onBlur={(event) => {
          // Leaving the field ends the edit: the draft is dropped so the
          // controlled value takes over again.
          setDraft(null);
          const parsed = Number.parseFloat(event.target.value);
          if (Number.isFinite(parsed) && parsed !== value) {
            onChange(parsed);
          }
        }}
        data-testid={id}
      />
    </div>
  );
}

export function PropertiesPanel({
  object,
  imageId,
  imageWidth,
  imageHeight,
  onUpdateGeometry,
  onUpdateStyle,
  onUpdateMetadata,
  onRemove,
  onToggleVisibility,
  onMove,
  disabled,
  onOverlayUploaded,
}: PropertiesPanelProps) {
  const overlayInputRef = useRef<HTMLInputElement | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [isUploadingOverlay, setIsUploadingOverlay] = useState(false);

  if (!object) {
    return (
      <section className={styles.panel} aria-labelledby="properties-heading">
        <h2 id="properties-heading" className={styles.heading}>
          Thuộc tính
        </h2>
        <p className="muted" data-testid="properties-empty">
          Chọn một đối tượng trên ảnh hoặc trong danh sách layer để chỉnh sửa.
        </p>
      </section>
    );
  }

  const handleOverlayUpload = async (file: File): Promise<void> => {
    setIsUploadingOverlay(true);
    setOverlayError(null);
    try {
      const overlay = await uploadOverlay(imageId, file);
      onOverlayUploaded(overlay._id);
      // Point the geometry at the newly uploaded overlay. The box is reshaped to
      // the overlay's own aspect ratio (anchored at the top-left, keeping the
      // drawn area as close as possible): otherwise a detailed bitmap gets
      // non-uniformly stretched across a mismatched box and looks broken.
      const geometry = object.geometry as ImageOverlayGeometry;
      onUpdateGeometry(
        fitGeometryToOverlay(geometry, overlay.width, overlay.height, overlay._id),
      );
    } catch (error) {
      setOverlayError(
        error instanceof ApiError ? error.message : 'Tải ảnh chồng lớp thất bại.',
      );
    } finally {
      setIsUploadingOverlay(false);
      if (overlayInputRef.current) overlayInputRef.current.value = '';
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="properties-heading">
      <h2 id="properties-heading" className={styles.heading}>
        Thuộc tính
      </h2>

      <div className={styles.typeRow}>
        <span className={styles.typeLabel} data-testid="properties-type">
          {TYPE_LABELS[object.type] ?? object.type}
        </span>
        {object.isNew && <span className={styles.unsaved}>chưa lưu</span>}
      </div>

      <div className={styles.actionsRow}>
        <button
          type="button"
          className="button button--small"
          onClick={onToggleVisibility}
          disabled={disabled}
          data-testid="toggle-object-visibility"
        >
          {object.visible ? 'Ẩn' : 'Hiện'}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => onMove('up')}
          disabled={disabled}
          data-testid="object-up"
        >
          ↑
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => onMove('down')}
          disabled={disabled}
          data-testid="object-down"
        >
          ↓
        </button>
        <button
          type="button"
          className="button button--small button--danger"
          onClick={onRemove}
          disabled={disabled}
          data-testid="remove-object"
        >
          Xoá
        </button>
      </div>

      {/* ------------------------------ geometry ----------------------------- */}

      <div className={styles.section}>
        <h3 className={styles.sectionHeading}>Toạ độ (pixel ảnh gốc)</h3>

        {object.type === 'POLYGON' && (
          <div className={styles.pointGrid}>
            {(object.geometry as PolygonGeometry).points.map((point, index) => (
              <div key={index} className={styles.pointRow}>
                <span className={styles.pointIndex}>#{index + 1}</span>
                <NumberField
                  id={`poly-x-${index}`}
                  label="X"
                  value={point.x}
                  min={0}
                  max={imageWidth}
                  disabled={disabled}
                  onChange={(x) => {
                    const points = [...(object.geometry as PolygonGeometry).points];
                    points[index] = { ...points[index], x };
                    onUpdateGeometry({ points });
                  }}
                />
                <NumberField
                  id={`poly-y-${index}`}
                  label="Y"
                  value={point.y}
                  min={0}
                  max={imageHeight}
                  disabled={disabled}
                  onChange={(y) => {
                    const points = [...(object.geometry as PolygonGeometry).points];
                    points[index] = { ...points[index], y };
                    onUpdateGeometry({ points });
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {object.type === 'RECTANGLE' && (
          <div className={styles.grid2}>
            <NumberField
              id="rect-x"
              label="X"
              value={(object.geometry as RectangleGeometry).x}
              min={0}
              max={imageWidth}
              disabled={disabled}
              onChange={(x) => onUpdateGeometry({ ...(object.geometry as RectangleGeometry), x })}
            />
            <NumberField
              id="rect-y"
              label="Y"
              value={(object.geometry as RectangleGeometry).y}
              min={0}
              max={imageHeight}
              disabled={disabled}
              onChange={(y) => onUpdateGeometry({ ...(object.geometry as RectangleGeometry), y })}
            />
            <NumberField
              id="rect-width"
              label="Rộng"
              value={(object.geometry as RectangleGeometry).width}
              min={1}
              disabled={disabled}
              onChange={(width) =>
                onUpdateGeometry({ ...(object.geometry as RectangleGeometry), width })
              }
            />
            <NumberField
              id="rect-height"
              label="Cao"
              value={(object.geometry as RectangleGeometry).height}
              min={1}
              disabled={disabled}
              onChange={(height) =>
                onUpdateGeometry({ ...(object.geometry as RectangleGeometry), height })
              }
            />
          </div>
        )}

        {(object.type === 'POINT' || object.type === 'LABEL') && (
          <div className={styles.grid2}>
            <NumberField
              id="point-x"
              label="X"
              value={(object.geometry as PointGeometry).x}
              min={0}
              max={imageWidth}
              disabled={disabled}
              onChange={(x) => onUpdateGeometry({ ...(object.geometry as PointGeometry), x })}
            />
            <NumberField
              id="point-y"
              label="Y"
              value={(object.geometry as PointGeometry).y}
              min={0}
              max={imageHeight}
              disabled={disabled}
              onChange={(y) => onUpdateGeometry({ ...(object.geometry as PointGeometry), y })}
            />
          </div>
        )}

        {object.type === 'IMAGE' && (
          <>
            <div className={styles.grid2}>
              <NumberField
                id="img-x"
                label="X"
                value={(object.geometry as ImageOverlayGeometry).x}
                min={0}
                max={imageWidth}
                disabled={disabled}
                onChange={(x) =>
                  onUpdateGeometry({ ...(object.geometry as ImageOverlayGeometry), x })
                }
              />
              <NumberField
                id="img-y"
                label="Y"
                value={(object.geometry as ImageOverlayGeometry).y}
                min={0}
                max={imageHeight}
                disabled={disabled}
                onChange={(y) =>
                  onUpdateGeometry({ ...(object.geometry as ImageOverlayGeometry), y })
                }
              />
              <NumberField
                id="img-width"
                label="Rộng"
                value={(object.geometry as ImageOverlayGeometry).width}
                min={1}
                disabled={disabled}
                onChange={(width) =>
                  onUpdateGeometry({ ...(object.geometry as ImageOverlayGeometry), width })
                }
              />
              <NumberField
                id="img-height"
                label="Cao"
                value={(object.geometry as ImageOverlayGeometry).height}
                min={1}
                disabled={disabled}
                onChange={(height) =>
                  onUpdateGeometry({ ...(object.geometry as ImageOverlayGeometry), height })
                }
              />
            </div>

            <input
              ref={overlayInputRef}
              type="file"
              accept="image/png,image/webp,image/jpeg,.png,.webp,.jpg,.jpeg"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleOverlayUpload(file);
              }}
              data-testid="overlay-file-input"
            />
            <button
              type="button"
              className="button button--small"
              onClick={() => overlayInputRef.current?.click()}
              disabled={disabled || isUploadingOverlay}
              data-testid="upload-overlay"
            >
              {isUploadingOverlay ? 'Đang tải…' : 'Tải ảnh PNG/WebP/JPG'}
            </button>
            {overlayError && (
              <p className="inline-error" role="alert">
                {overlayError}
              </p>
            )}
          </>
        )}
      </div>

      {/* -------------------------------- label ------------------------------ */}

      {object.type === 'LABEL' && (
        <div className={styles.section}>
          <div className="field">
            <label htmlFor="label-text">Nội dung nhãn</label>
            <textarea
              id="label-text"
              rows={2}
              maxLength={500}
              value={(object.metadata as { text?: string }).text ?? ''}
              disabled={disabled}
              onChange={(event) => onUpdateMetadata({ text: event.target.value })}
              data-testid="label-text-input"
            />
          </div>
        </div>
      )}

      {/* -------------------------------- style ------------------------------ */}

      <div className={styles.section}>
        <h3 className={styles.sectionHeading}>Kiểu hiển thị</h3>

        {(object.type === 'POLYGON' || object.type === 'RECTANGLE') && (
          <PolygonStyleEditor
            style={{
              ...(object.type === 'RECTANGLE' ? DEFAULT_RECTANGLE_STYLE : DEFAULT_POLYGON_STYLE),
              ...(object.style as Partial<PolygonStyleView>),
            }}
            onChange={onUpdateStyle}
            disabled={disabled}
          />
        )}

        {object.type === 'POINT' && (
          <PointStyleEditor
            style={{ ...DEFAULT_POINT_STYLE, ...(object.style as Partial<PointStyleView>) }}
            onChange={onUpdateStyle}
            disabled={disabled}
          />
        )}

        {object.type === 'LABEL' && (
          <LabelStyleEditor
            style={{ ...DEFAULT_LABEL_STYLE, ...(object.style as Partial<LabelStyleView>) }}
            onChange={onUpdateStyle}
            disabled={disabled}
          />
        )}

        {object.type === 'IMAGE' && (
          <div className="field">
            <label htmlFor="image-opacity">Độ mờ</label>
            <div className="field-row">
              <input
                id="image-opacity"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={(object.style as Partial<ImageStyleView>).opacity ?? 1}
                disabled={disabled}
                onChange={(event) => onUpdateStyle({ opacity: Number(event.target.value) })}
                data-testid="image-opacity"
              />
              <span className="muted">
                {Math.round(((object.style as Partial<ImageStyleView>).opacity ?? 1) * 100)}%
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* --------------------------- style sub-editors ---------------------------- */

function PolygonStyleEditor({
  style,
  onChange,
  disabled,
}: {
  style: PolygonStyleView;
  onChange: (patch: Partial<LayerObjectStyle>) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className={styles.grid2}>
        <div className="field">
          <label htmlFor="style-fill">Màu nền</label>
          <input
            id="style-fill"
            type="color"
            value={style.fill}
            disabled={disabled}
            onChange={(event) => onChange({ fill: event.target.value })}
            data-testid="style-fill"
          />
        </div>
        <div className="field">
          <label htmlFor="style-stroke">Màu viền</label>
          <input
            id="style-stroke"
            type="color"
            value={style.stroke}
            disabled={disabled}
            onChange={(event) => onChange({ stroke: event.target.value })}
            data-testid="style-stroke"
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="style-fill-opacity">Độ mờ nền ({Math.round(style.fillOpacity * 100)}%)</label>
        <input
          id="style-fill-opacity"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={style.fillOpacity}
          disabled={disabled}
          onChange={(event) => onChange({ fillOpacity: Number(event.target.value) })}
          data-testid="style-fill-opacity"
        />
      </div>

      <div className="field">
        <label htmlFor="style-stroke-width">Độ dày viền ({style.strokeWidth})</label>
        <input
          id="style-stroke-width"
          type="range"
          min={0}
          max={20}
          step={0.5}
          value={style.strokeWidth}
          disabled={disabled}
          onChange={(event) => onChange({ strokeWidth: Number(event.target.value) })}
          data-testid="style-stroke-width"
        />
      </div>
    </>
  );
}

function PointStyleEditor({
  style,
  onChange,
  disabled,
}: {
  style: PointStyleView;
  onChange: (patch: Partial<LayerObjectStyle>) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className={styles.grid2}>
        <div className="field">
          <label htmlFor="point-fill">Màu</label>
          <input
            id="point-fill"
            type="color"
            value={style.fill}
            disabled={disabled}
            onChange={(event) => onChange({ fill: event.target.value })}
            data-testid="point-fill"
          />
        </div>
        <div className="field">
          <label htmlFor="point-stroke">Màu viền</label>
          <input
            id="point-stroke"
            type="color"
            value={style.stroke}
            disabled={disabled}
            onChange={(event) => onChange({ stroke: event.target.value })}
            data-testid="point-stroke"
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="point-radius">Bán kính ({style.radius})</label>
        <input
          id="point-radius"
          type="range"
          min={2}
          max={40}
          step={1}
          value={style.radius}
          disabled={disabled}
          onChange={(event) => onChange({ radius: Number(event.target.value) })}
          data-testid="point-radius"
        />
      </div>
    </>
  );
}

function LabelStyleEditor({
  style,
  onChange,
  disabled,
}: {
  style: LabelStyleView;
  onChange: (patch: Partial<LayerObjectStyle>) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className={styles.grid2}>
        <div className="field">
          <label htmlFor="label-color">Màu chữ</label>
          <input
            id="label-color"
            type="color"
            value={style.color}
            disabled={disabled}
            onChange={(event) => onChange({ color: event.target.value })}
            data-testid="label-color"
          />
        </div>
        <NumberField
          id="label-font-size"
          label="Cỡ chữ (px ảnh)"
          value={style.fontSize}
          min={4}
          max={512}
          disabled={disabled}
          onChange={(fontSize) => onChange({ fontSize })}
        />
      </div>
      <div className="field">
        <label htmlFor="label-font-family">Font</label>
        <select
          id="label-font-family"
          value={style.fontFamily}
          disabled={disabled}
          onChange={(event) => onChange({ fontFamily: event.target.value })}
          data-testid="label-font-family"
        >
          <option value="system-ui, sans-serif">System UI</option>
          <option value="Arial, sans-serif">Arial</option>
          <option value="'Segoe UI', sans-serif">Segoe UI</option>
          <option value="Georgia, serif">Georgia</option>
          <option value="'Courier New', monospace">Courier New</option>
        </select>
      </div>
    </>
  );
}
