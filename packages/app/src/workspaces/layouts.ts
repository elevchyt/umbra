/**
 * Dock layouts and the built-in workspace presets — spec 01 §1.1.
 *
 * Photoshop's panel system is a set of vertical COLUMNS on the right; each column is a stack
 * of tab GROUPS; each group shows one of its tabbed panels. A column can collapse to an icon
 * strip. That is deliberately simpler than IDE-style docking, and modelling it directly keeps
 * the implementation small (spec 03 §1: no docking library).
 */

export interface DockGroup {
  id: string;
  /** Panel ids shown as tabs in this group. */
  panels: string[];
  /** Which tab is frontmost. */
  active: string;
  /** Vertical share of the column. */
  flex: number;
  /** Collapsed to just its tab strip (double-click a tab). */
  minimized?: boolean;
}

export interface DockColumn {
  id: string;
  width: number;
  /** Collapsed to an icon strip. */
  collapsed: boolean;
  groups: DockGroup[];
}

export interface DockLayout {
  columns: DockColumn[];
}

export const DEFAULT_LAYOUT: DockLayout = {
  columns: [
    {
      id: 'col-icons',
      width: 34,
      collapsed: true,
      groups: [
        { id: 'g-history', panels: ['history'], active: 'history', flex: 1 },
        { id: 'g-brushes', panels: ['brushSettings', 'brushes'], active: 'brushSettings', flex: 1 },
      ],
    },
    {
      id: 'col-main',
      width: 300,
      collapsed: false,
      groups: [
        {
          id: 'g-color',
          panels: ['color', 'swatches', 'gradients', 'patterns'],
          active: 'color',
          flex: 0.9,
        },
        { id: 'g-props', panels: ['properties', 'adjustments'], active: 'properties', flex: 1.1 },
        { id: 'g-layers', panels: ['layers', 'channels', 'paths'], active: 'layers', flex: 1.6 },
      ],
    },
  ],
};

const PAINTING_LAYOUT: DockLayout = {
  columns: [
    {
      id: 'col-icons',
      width: 34,
      collapsed: true,
      groups: [{ id: 'g-nav', panels: ['navigator', 'histogram'], active: 'navigator', flex: 1 }],
    },
    {
      id: 'col-main',
      width: 300,
      collapsed: false,
      groups: [
        { id: 'g-brush', panels: ['brushSettings', 'brushes'], active: 'brushSettings', flex: 1.4 },
        { id: 'g-color', panels: ['color', 'swatches'], active: 'color', flex: 0.8 },
        { id: 'g-layers', panels: ['layers', 'channels', 'paths'], active: 'layers', flex: 1.3 },
      ],
    },
  ],
};

const PHOTOGRAPHY_LAYOUT: DockLayout = {
  columns: [
    {
      id: 'col-icons',
      width: 34,
      collapsed: true,
      groups: [{ id: 'g-hist', panels: ['history', 'actions'], active: 'history', flex: 1 }],
    },
    {
      id: 'col-main',
      width: 320,
      collapsed: false,
      groups: [
        { id: 'g-navinfo', panels: ['navigator', 'histogram', 'info'], active: 'histogram', flex: 0.9 },
        { id: 'g-adjust', panels: ['adjustments', 'properties'], active: 'adjustments', flex: 1 },
        { id: 'g-layers', panels: ['layers', 'channels', 'paths'], active: 'layers', flex: 1.5 },
      ],
    },
  ],
};

const GRAPHIC_WEB_LAYOUT: DockLayout = {
  columns: [
    {
      id: 'col-icons',
      width: 34,
      collapsed: true,
      groups: [{ id: 'g-hist', panels: ['history'], active: 'history', flex: 1 }],
    },
    {
      id: 'col-main',
      width: 310,
      collapsed: false,
      groups: [
        { id: 'g-char', panels: ['character', 'paragraph'], active: 'character', flex: 0.9 },
        { id: 'g-color', panels: ['color', 'swatches', 'gradients'], active: 'swatches', flex: 0.9 },
        { id: 'g-layers', panels: ['layers', 'channels', 'paths'], active: 'layers', flex: 1.5 },
      ],
    },
  ],
};

export interface WorkspacePreset {
  id: string;
  label: string;
  layout: DockLayout;
}

export const WORKSPACES: WorkspacePreset[] = [
  { id: 'essentials', label: 'Essentials (Default)', layout: DEFAULT_LAYOUT },
  { id: 'painting', label: 'Painting', layout: PAINTING_LAYOUT },
  { id: 'photography', label: 'Photography', layout: PHOTOGRAPHY_LAYOUT },
  { id: 'graphicWeb', label: 'Graphic and Web', layout: GRAPHIC_WEB_LAYOUT },
];

export const WORKSPACE_BY_ID = new Map(WORKSPACES.map((w) => [w.id, w]));
