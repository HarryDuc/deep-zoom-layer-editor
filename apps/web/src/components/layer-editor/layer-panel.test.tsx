import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayerPanel } from './layer-panel';
import type { DraftLayer, DraftObject } from '@/lib/editor-state';

function makeLayer(overrides: Partial<DraftLayer> = {}): DraftLayer {
  return {
    id: 'layer-1',
    name: 'Lớp nền',
    visible: true,
    locked: false,
    zIndex: 0,
    isNew: false,
    isPersisted: true,
    ...overrides,
  };
}

function makeObject(overrides: Partial<DraftObject> = {}): DraftObject {
  return {
    id: 'object-1',
    layerId: 'layer-1',
    type: 'POLYGON',
    geometry: { points: [] },
    style: {} as DraftObject['style'],
    metadata: {},
    visible: true,
    zIndex: 0,
    isNew: false,
    isPersisted: true,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof LayerPanel>> = {}) {
  const handlers = {
    onActivateLayer: vi.fn(),
    onRenameLayer: vi.fn(),
    onToggleVisibility: vi.fn(),
    onToggleLock: vi.fn(),
    onRemoveLayer: vi.fn(),
    onMoveLayer: vi.fn(),
    onSelectObject: vi.fn(),
    onAddLayer: vi.fn(),
  };

  const utils = render(
    <LayerPanel
      layers={[makeLayer()]}
      objects={[]}
      activeLayerId="layer-1"
      selectedObjectId={null}
      disabled={false}
      {...handlers}
      {...overrides}
    />,
  );

  return { ...utils, ...handlers };
}

describe('LayerPanel', () => {
  it('shows an empty state when no layers exist', () => {
    renderPanel({ layers: [], activeLayerId: null });
    expect(screen.getByTestId('layers-empty')).toBeInTheDocument();
  });

  it('lists layers top-most first', () => {
    renderPanel({
      layers: [
        makeLayer({ id: 'bottom', name: 'Dưới', zIndex: 0 }),
        makeLayer({ id: 'top', name: 'Trên', zIndex: 5 }),
      ],
      activeLayerId: 'bottom',
    });

    const items = screen.getAllByTestId(/^layer-item-/);
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual([
      'layer-item-top',
      'layer-item-bottom',
    ]);
  });

  it('activates a layer on click', async () => {
    const user = userEvent.setup();
    const { onActivateLayer } = renderPanel();

    await user.click(screen.getByTestId('layer-name-layer-1'));

    expect(onActivateLayer).toHaveBeenCalledWith('layer-1');
  });

  it('toggles visibility and lock with accessible state', async () => {
    const user = userEvent.setup();
    const { onToggleVisibility, onToggleLock } = renderPanel();

    const visibility = screen.getByTestId('toggle-layer-visibility-layer-1');
    expect(visibility).toHaveAttribute('aria-pressed', 'true');
    await user.click(visibility);
    expect(onToggleVisibility).toHaveBeenCalledWith('layer-1');

    const lock = screen.getByTestId('toggle-layer-lock-layer-1');
    expect(lock).toHaveAttribute('aria-pressed', 'false');
    await user.click(lock);
    expect(onToggleLock).toHaveBeenCalledWith('layer-1');
  });

  it('reflects a hidden and locked layer in the toggles', () => {
    renderPanel({ layers: [makeLayer({ visible: false, locked: true })] });

    expect(screen.getByTestId('toggle-layer-visibility-layer-1')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByTestId('toggle-layer-lock-layer-1')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renames a layer on double click + Enter', async () => {
    const user = userEvent.setup();
    const { onRenameLayer } = renderPanel();

    await user.dblClick(screen.getByTestId('layer-name-layer-1'));
    const input = screen.getByTestId('layer-name-input-layer-1');
    await user.clear(input);
    await user.type(input, 'Lớp mới{Enter}');

    expect(onRenameLayer).toHaveBeenCalledWith('layer-1', 'Lớp mới');
  });

  it('does not rename when Escape is pressed', async () => {
    const user = userEvent.setup();
    const { onRenameLayer } = renderPanel();

    await user.dblClick(screen.getByTestId('layer-name-layer-1'));
    const input = screen.getByTestId('layer-name-input-layer-1');
    await user.type(input, 'abc{Escape}');

    expect(onRenameLayer).not.toHaveBeenCalled();
    expect(screen.getByTestId('layer-name-layer-1')).toBeInTheDocument();
  });

  it('moves and deletes layers through their controls', async () => {
    const user = userEvent.setup();
    const { onMoveLayer, onRemoveLayer } = renderPanel();

    await user.click(screen.getByTestId('layer-up-layer-1'));
    expect(onMoveLayer).toHaveBeenCalledWith('layer-1', 'up');

    await user.click(screen.getByTestId('layer-down-layer-1'));
    expect(onMoveLayer).toHaveBeenCalledWith('layer-1', 'down');

    await user.click(screen.getByTestId('remove-layer-layer-1'));
    expect(onRemoveLayer).toHaveBeenCalledWith('layer-1');
  });

  it('adds a layer with the typed name and clears the input', async () => {
    const user = userEvent.setup();
    const { onAddLayer } = renderPanel();

    const input = screen.getByTestId('new-layer-name');
    const addButton = screen.getByTestId('add-layer');
    expect(addButton).toBeDisabled();

    await user.type(input, 'Lớp mới');
    expect(addButton).toBeEnabled();
    await user.click(addButton);

    expect(onAddLayer).toHaveBeenCalledWith('Lớp mới');
    expect(input).toHaveValue('');
  });

  it('adds a layer on Enter and ignores whitespace-only names', async () => {
    const user = userEvent.setup();
    const { onAddLayer } = renderPanel();

    const input = screen.getByTestId('new-layer-name');
    await user.type(input, '   ');
    await user.type(input, '{Enter}');
    expect(onAddLayer).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, 'Lớp B{Enter}');
    expect(onAddLayer).toHaveBeenCalledWith('Lớp B');
  });

  it('groups objects under their layer, newest on top', () => {
    renderPanel({
      objects: [
        makeObject({ id: 'low', type: 'POINT', zIndex: 0 }),
        makeObject({ id: 'high', type: 'LABEL', zIndex: 3 }),
        makeObject({ id: 'other-layer', layerId: 'layer-2', zIndex: 9 }),
      ],
    });

    const layerItem = screen.getByTestId('layer-item-layer-1');
    const items = within(layerItem).getAllByTestId(/^object-item-/);
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual([
      'object-item-high',
      'object-item-low',
    ]);
  });

  it('shows a type label and a "new" badge for unsaved objects', () => {
    renderPanel({
      objects: [makeObject({ id: 'draft', type: 'RECTANGLE', isNew: true, isPersisted: false })],
    });

    const item = screen.getByTestId('object-item-draft');
    expect(item).toHaveTextContent('Chữ nhật');
    expect(item).toHaveTextContent('mới');
  });

  it('selects an object from the list', async () => {
    const user = userEvent.setup();
    const { onSelectObject } = renderPanel({
      objects: [makeObject({ id: 'object-1' })],
    });

    await user.click(screen.getByTestId('object-item-object-1'));

    expect(onSelectObject).toHaveBeenCalledWith('object-1');
  });

  it('disables mutating controls while saving', () => {
    renderPanel({ disabled: true });

    expect(screen.getByTestId('new-layer-name')).toBeDisabled();
    // The add button is disabled because the name is empty, regardless of save
    // state; removal/move must honour the disabled flag.
    expect(screen.getByTestId('remove-layer-layer-1')).toBeDisabled();
    expect(screen.getByTestId('layer-up-layer-1')).toBeDisabled();
  });
});
