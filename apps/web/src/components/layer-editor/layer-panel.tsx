'use client';

import { useState } from 'react';
import type { DraftLayer, DraftObject } from '@/lib/editor-state';
import styles from './layer-panel.module.css';

export interface LayerPanelProps {
  layers: DraftLayer[];
  objects: DraftObject[];
  activeLayerId: string | null;
  selectedObjectId: string | null;
  onActivateLayer: (layerId: string) => void;
  onRenameLayer: (layerId: string, name: string) => void;
  onToggleVisibility: (layerId: string) => void;
  onToggleLock: (layerId: string) => void;
  onRemoveLayer: (layerId: string) => void;
  onMoveLayer: (layerId: string, direction: 'up' | 'down') => void;
  onSelectObject: (objectId: string) => void;
  onAddLayer: (name: string) => void;
  disabled?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  POLYGON: 'Đa giác',
  RECTANGLE: 'Chữ nhật',
  POINT: 'Điểm',
  LABEL: 'Nhãn',
  IMAGE: 'Ảnh',
};

export function LayerPanel({
  layers,
  objects,
  activeLayerId,
  selectedObjectId,
  onActivateLayer,
  onRenameLayer,
  onToggleVisibility,
  onToggleLock,
  onRemoveLayer,
  onMoveLayer,
  onSelectObject,
  onAddLayer,
  disabled,
}: LayerPanelProps) {
  const [newLayerName, setNewLayerName] = useState('');
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const ordered = [...layers].sort((a, b) => b.zIndex - a.zIndex);

  const commitRename = (layerId: string): void => {
    onRenameLayer(layerId, editingName);
    setEditingLayerId(null);
    setEditingName('');
  };

  const handleAdd = (): void => {
    const name = newLayerName.trim();
    if (name.length === 0) return;
    onAddLayer(name);
    setNewLayerName('');
  };

  return (
    <section className={styles.panel} aria-labelledby="layer-panel-heading">
      <h2 id="layer-panel-heading" className={styles.heading}>
        Layer
      </h2>

      <div className={styles.addRow}>
        <input
          type="text"
          value={newLayerName}
          placeholder="Tên layer mới"
          maxLength={120}
          onChange={(event) => setNewLayerName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleAdd();
          }}
          disabled={disabled}
          data-testid="new-layer-name"
        />
        <button
          type="button"
          className="button button--small"
          onClick={handleAdd}
          disabled={disabled || newLayerName.trim().length === 0}
          data-testid="add-layer"
        >
          Thêm
        </button>
      </div>

      {ordered.length === 0 && (
        <p className={styles.empty} data-testid="layers-empty">
          Chưa có layer. Tạo một layer để bắt đầu vẽ.
        </p>
      )}

      <ul className={styles.layerList}>
        {ordered.map((layer) => {
          const layerObjects = objects
            .filter((object) => object.layerId === layer.id)
            .sort((a, b) => b.zIndex - a.zIndex);
          const isActive = layer.id === activeLayerId;

          return (
            <li
              key={layer.id}
              className={`${styles.layerItem} ${isActive ? styles.layerItemActive : ''}`}
              data-testid={`layer-item-${layer.id}`}
            >
              <div className={styles.layerHeader}>
                <button
                  type="button"
                  className={styles.visibilityToggle}
                  onClick={() => onToggleVisibility(layer.id)}
                  aria-label={layer.visible ? 'Ẩn layer' : 'Hiện layer'}
                  aria-pressed={layer.visible}
                  title={layer.visible ? 'Ẩn layer' : 'Hiện layer'}
                  data-testid={`toggle-layer-visibility-${layer.id}`}
                >
                  {layer.visible ? '◉' : '○'}
                </button>

                <button
                  type="button"
                  className={styles.lockToggle}
                  onClick={() => onToggleLock(layer.id)}
                  aria-label={layer.locked ? 'Mở khoá layer' : 'Khoá layer'}
                  aria-pressed={layer.locked}
                  title={layer.locked ? 'Mở khoá layer' : 'Khoá layer'}
                  data-testid={`toggle-layer-lock-${layer.id}`}
                >
                  {layer.locked ? '🔒' : '🔓'}
                </button>

                {editingLayerId === layer.id ? (
                  <input
                    type="text"
                    className={styles.nameInput}
                    value={editingName}
                    autoFocus
                    maxLength={120}
                    onChange={(event) => setEditingName(event.target.value)}
                    onBlur={() => commitRename(layer.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename(layer.id);
                      if (event.key === 'Escape') setEditingLayerId(null);
                    }}
                    data-testid={`layer-name-input-${layer.id}`}
                  />
                ) : (
                  <button
                    type="button"
                    className={styles.layerName}
                    onClick={() => onActivateLayer(layer.id)}
                    onDoubleClick={() => {
                      setEditingLayerId(layer.id);
                      setEditingName(layer.name);
                    }}
                    title="Nhấn để chọn, nhấn đúp để đổi tên"
                    data-testid={`layer-name-${layer.id}`}
                  >
                    {layer.name}
                  </button>
                )}
              </div>

              <div className={styles.layerActions}>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => onMoveLayer(layer.id, 'up')}
                  disabled={disabled}
                  title="Đưa layer lên"
                  data-testid={`layer-up-${layer.id}`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => onMoveLayer(layer.id, 'down')}
                  disabled={disabled}
                  title="Đưa layer xuống"
                  data-testid={`layer-down-${layer.id}`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="button button--small button--danger"
                  onClick={() => onRemoveLayer(layer.id)}
                  disabled={disabled}
                  data-testid={`remove-layer-${layer.id}`}
                >
                  Xoá
                </button>
              </div>

              {layerObjects.length > 0 && (
                <ul className={styles.objectList}>
                  {layerObjects.map((object) => (
                    <li key={object.id}>
                      <button
                        type="button"
                        className={`${styles.objectItem} ${
                          object.id === selectedObjectId ? styles.objectItemSelected : ''
                        }`}
                        onClick={() => onSelectObject(object.id)}
                        data-testid={`object-item-${object.id}`}
                      >
                        <span className={styles.objectType}>
                          {TYPE_LABELS[object.type] ?? object.type}
                        </span>
                        {object.isNew && <span className={styles.newBadge}>mới</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
