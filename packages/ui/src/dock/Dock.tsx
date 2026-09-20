import { For, Show, createSignal, type JSX } from 'solid-js';
import { Icon } from '../icons/Icon';

/**
 * Panel dock — spec 01 §1 ("Panel docks").
 *
 * Columns of tab groups, each group showing one tabbed panel. A column collapses to an icon
 * strip; a group minimises to its tab strip on double-click; tabs drag between groups with a
 * blue insertion line. Written directly rather than pulled from a docking library: the model
 * is small, and the closest library (dockview) costs 85 KB gzipped — four times our entire
 * current payload (spec 03 §1).
 */

export interface DockGroupModel {
  id: string;
  panels: string[];
  active: string;
  flex: number;
  minimized?: boolean;
}

export interface DockColumnModel {
  id: string;
  width: number;
  collapsed: boolean;
  groups: DockGroupModel[];
}

export interface DockLayoutModel {
  columns: DockColumnModel[];
}

export interface PanelMeta {
  title: string;
  icon: string;
}

export interface DockProps {
  layout: DockLayoutModel;
  meta: Record<string, PanelMeta>;
  renderPanel: (id: string) => JSX.Element;
  onActivate: (columnId: string, groupId: string, panelId: string) => void;
  onToggleCollapse: (columnId: string) => void;
  onToggleMinimize: (columnId: string, groupId: string) => void;
  onClosePanel: (panelId: string) => void;
  onMovePanel: (panelId: string, toColumn: string, toGroup: string, index: number) => void;
  onResizeColumn: (columnId: string, width: number) => void;
  onPanelMenu: (panelId: string, x: number, y: number) => void;
}

interface DropTarget {
  columnId: string;
  groupId: string;
  index: number;
}

export function Dock(props: DockProps) {
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);

  const metaOf = (id: string): PanelMeta => props.meta[id] ?? { title: id, icon: 'panelMenu' };

  const startColumnResize = (col: DockColumnModel, e: PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = col.width;
    const move = (ev: PointerEvent) => {
      // Columns grow leftwards, so a drag to the left widens them.
      props.onResizeColumn(col.id, Math.max(160, Math.min(620, startW - (ev.clientX - startX))));
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  return (
    <div class="dock">
      <For each={props.layout.columns}>
        {(col) => (
          <div class="dock-column" classList={{ collapsed: col.collapsed }} style={{ width: `${col.collapsed ? 34 : col.width}px` }}>
            <Show when={!col.collapsed}>
              <div class="dock-resize" onPointerDown={(e) => startColumnResize(col, e)} />
            </Show>

            <div class="dock-column-head">
              <button
                type="button"
                class="dock-collapse"
                title={col.collapsed ? 'Expand Panels' : 'Collapse to Icons'}
                onClick={() => props.onToggleCollapse(col.id)}
              >
                <Icon name={col.collapsed ? 'doubleChevronLeft' : 'doubleChevronRight'} size={12} />
              </button>
            </div>

            <Show
              when={!col.collapsed}
              fallback={
                <div class="dock-iconstrip">
                  <For each={col.groups}>
                    {(g) => (
                      <For each={g.panels}>
                        {(id) => (
                          <button
                            type="button"
                            class="dock-icon"
                            title={metaOf(id).title}
                            onClick={() => {
                              props.onToggleCollapse(col.id);
                              props.onActivate(col.id, g.id, id);
                            }}
                          >
                            <Icon name={metaOf(id).icon} size={16} />
                          </button>
                        )}
                      </For>
                    )}
                  </For>
                </div>
              }
            >
              <div class="dock-groups">
                <For each={col.groups}>
                  {(g) => (
                    <div
                      class="dock-group"
                      classList={{ minimized: g.minimized }}
                      style={{ 'flex-grow': g.minimized ? 0 : g.flex }}
                    >
                      <div class="dock-tabs">
                        <For each={g.panels}>
                          {(id, idx) => (
                            <div
                              class="dock-tab"
                              classList={{
                                active: g.active === id,
                                dragging: dragging() === id,
                                'drop-before':
                                  dropTarget()?.groupId === g.id && dropTarget()?.index === idx(),
                              }}
                              draggable={true}
                              onClick={() => props.onActivate(col.id, g.id, id)}
                              onDblClick={() => props.onToggleMinimize(col.id, g.id)}
                              onDragStart={(e) => {
                                setDragging(id);
                                e.dataTransfer?.setData('text/plain', id);
                                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                              }}
                              onDragEnd={() => {
                                setDragging(null);
                                setDropTarget(null);
                              }}
                              onDragOver={(e) => {
                                if (!dragging()) return;
                                e.preventDefault();
                                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                const after = e.clientX > r.left + r.width / 2;
                                setDropTarget({ columnId: col.id, groupId: g.id, index: idx() + (after ? 1 : 0) });
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                const panel = dragging();
                                const t = dropTarget();
                                if (panel && t) props.onMovePanel(panel, t.columnId, t.groupId, t.index);
                                setDragging(null);
                                setDropTarget(null);
                              }}
                            >
                              {metaOf(id).title}
                            </div>
                          )}
                        </For>
                        <div
                          class="dock-tabs-filler"
                          onDragOver={(e) => {
                            if (!dragging()) return;
                            e.preventDefault();
                            setDropTarget({ columnId: col.id, groupId: g.id, index: g.panels.length });
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const panel = dragging();
                            const t = dropTarget();
                            if (panel && t) props.onMovePanel(panel, t.columnId, t.groupId, t.index);
                            setDragging(null);
                            setDropTarget(null);
                          }}
                        />
                        <button
                          type="button"
                          class="dock-menu-button"
                          title="Panel menu"
                          onClick={(e) => {
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            props.onPanelMenu(g.active, r.right, r.bottom);
                          }}
                        >
                          <Icon name="panelMenu" size={13} />
                        </button>
                      </div>

                      <Show when={!g.minimized}>
                        <div class="dock-body">{props.renderPanel(g.active)}</div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
