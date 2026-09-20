/**
 * Tool registry — spec 01 §1 (tools panel) and §6 (shortcut letters).
 *
 * Groups are listed in panel order. Within a group, Shift+<letter> cycles members, matching
 * Photoshop's "Use Shift Key for Tool Switch" default. `implemented` marks what actually does
 * something today: unimplemented tools still appear and are still selectable, because the M1
 * exit criterion is that a Photoshop user finds everything where they expect it — but the
 * options bar and status bar say plainly that the tool is not wired up yet.
 */

export interface ToolDef {
  id: string;
  name: string;
  icon: string;
  /** Shortcut letter; shared by every member of a group. */
  key?: string;
  implemented?: boolean;
  /** Short hint shown in the status bar, in Photoshop's tool-hint style. */
  hint?: string;
}

export interface ToolGroup {
  id: string;
  key?: string;
  tools: ToolDef[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'move',
    key: 'v',
    tools: [
      { id: 'move', name: 'Move Tool', icon: 'move', key: 'v', implemented: true, hint: 'Drag to move layers. Hold Alt to duplicate.' },
      { id: 'artboard', name: 'Artboard Tool', icon: 'artboard', key: 'v' },
    ],
  },
  {
    id: 'marquee',
    key: 'm',
    tools: [
      { id: 'marqueeRect', name: 'Rectangular Marquee Tool', icon: 'marqueeRect', key: 'm', hint: 'Drag to select. Shift constrains to a square.' },
      { id: 'marqueeEllipse', name: 'Elliptical Marquee Tool', icon: 'marqueeEllipse', key: 'm' },
      { id: 'marqueeRow', name: 'Single Row Marquee Tool', icon: 'marqueeRow' },
      { id: 'marqueeColumn', name: 'Single Column Marquee Tool', icon: 'marqueeColumn' },
    ],
  },
  {
    id: 'lasso',
    key: 'l',
    tools: [
      { id: 'lasso', name: 'Lasso Tool', icon: 'lasso', key: 'l' },
      { id: 'lassoPolygon', name: 'Polygonal Lasso Tool', icon: 'lassoPolygon', key: 'l' },
      { id: 'lassoMagnetic', name: 'Magnetic Lasso Tool', icon: 'lassoMagnetic', key: 'l' },
      { id: 'selectionBrush', name: 'Selection Brush Tool', icon: 'selectionBrush', key: 'l' },
    ],
  },
  {
    id: 'quickSelect',
    key: 'w',
    tools: [
      { id: 'objectSelect', name: 'Object Selection Tool', icon: 'objectSelect', key: 'w' },
      { id: 'quickSelect', name: 'Quick Selection Tool', icon: 'quickSelect', key: 'w' },
      { id: 'magicWand', name: 'Magic Wand Tool', icon: 'magicWand', key: 'w' },
    ],
  },
  {
    id: 'crop',
    key: 'c',
    tools: [
      { id: 'crop', name: 'Crop Tool', icon: 'crop', key: 'c' },
      { id: 'cropPerspective', name: 'Perspective Crop Tool', icon: 'cropPerspective', key: 'c' },
      { id: 'slice', name: 'Slice Tool', icon: 'slice', key: 'c' },
      { id: 'sliceSelect', name: 'Slice Select Tool', icon: 'sliceSelect', key: 'c' },
    ],
  },
  { id: 'frame', key: 'k', tools: [{ id: 'frame', name: 'Frame Tool', icon: 'frame', key: 'k' }] },
  {
    id: 'sample',
    key: 'i',
    tools: [
      { id: 'eyedropper', name: 'Eyedropper Tool', icon: 'eyedropper', key: 'i', hint: 'Click to sample a foreground colour. Alt-click for background.' },
      { id: 'colorSampler', name: 'Color Sampler Tool', icon: 'colorSampler', key: 'i' },
      { id: 'ruler', name: 'Ruler Tool', icon: 'ruler', key: 'i' },
      { id: 'note', name: 'Note Tool', icon: 'note', key: 'i' },
      { id: 'count', name: 'Count Tool', icon: 'count', key: 'i' },
    ],
  },
  {
    id: 'retouch',
    key: 'j',
    tools: [
      { id: 'spotHealing', name: 'Spot Healing Brush Tool', icon: 'spotHealing', key: 'j' },
      { id: 'removeTool', name: 'Remove Tool', icon: 'removeTool', key: 'j' },
      { id: 'healingBrush', name: 'Healing Brush Tool', icon: 'healingBrush', key: 'j' },
      { id: 'patch', name: 'Patch Tool', icon: 'patch', key: 'j' },
      { id: 'contentAwareMove', name: 'Content-Aware Move Tool', icon: 'contentAwareMove', key: 'j' },
      { id: 'redEye', name: 'Red Eye Tool', icon: 'redEye', key: 'j' },
    ],
  },
  {
    id: 'paint',
    key: 'b',
    tools: [
      { id: 'brush', name: 'Brush Tool', icon: 'brush', key: 'b', implemented: true, hint: 'Drag to paint. [ and ] change the brush size.' },
      { id: 'pencil', name: 'Pencil Tool', icon: 'pencil', key: 'b' },
      { id: 'colorReplacement', name: 'Color Replacement Tool', icon: 'colorReplacement', key: 'b' },
      { id: 'mixerBrush', name: 'Mixer Brush Tool', icon: 'mixerBrush', key: 'b' },
    ],
  },
  {
    id: 'stamp',
    key: 's',
    tools: [
      { id: 'cloneStamp', name: 'Clone Stamp Tool', icon: 'cloneStamp', key: 's' },
      { id: 'patternStamp', name: 'Pattern Stamp Tool', icon: 'patternStamp', key: 's' },
    ],
  },
  {
    id: 'history',
    key: 'y',
    tools: [
      { id: 'historyBrush', name: 'History Brush Tool', icon: 'historyBrush', key: 'y' },
      { id: 'artHistoryBrush', name: 'Art History Brush Tool', icon: 'artHistoryBrush', key: 'y' },
    ],
  },
  {
    id: 'erase',
    key: 'e',
    tools: [
      { id: 'eraser', name: 'Eraser Tool', icon: 'eraser', key: 'e' },
      { id: 'backgroundEraser', name: 'Background Eraser Tool', icon: 'backgroundEraser', key: 'e' },
      { id: 'magicEraser', name: 'Magic Eraser Tool', icon: 'magicEraser', key: 'e' },
    ],
  },
  {
    id: 'fill',
    key: 'g',
    tools: [
      { id: 'gradient', name: 'Gradient Tool', icon: 'gradient', key: 'g' },
      { id: 'paintBucket', name: 'Paint Bucket Tool', icon: 'paintBucket', key: 'g' },
    ],
  },
  {
    id: 'focus',
    tools: [
      { id: 'blurTool', name: 'Blur Tool', icon: 'blurTool' },
      { id: 'sharpenTool', name: 'Sharpen Tool', icon: 'sharpenTool' },
      { id: 'smudgeTool', name: 'Smudge Tool', icon: 'smudgeTool' },
    ],
  },
  {
    id: 'tone',
    key: 'o',
    tools: [
      { id: 'dodgeTool', name: 'Dodge Tool', icon: 'dodgeTool', key: 'o' },
      { id: 'burnTool', name: 'Burn Tool', icon: 'burnTool', key: 'o' },
      { id: 'spongeTool', name: 'Sponge Tool', icon: 'spongeTool', key: 'o' },
    ],
  },
  {
    id: 'pen',
    key: 'p',
    tools: [
      { id: 'pen', name: 'Pen Tool', icon: 'pen', key: 'p' },
      { id: 'freeformPen', name: 'Freeform Pen Tool', icon: 'freeformPen', key: 'p' },
      { id: 'curvaturePen', name: 'Curvature Pen Tool', icon: 'curvaturePen', key: 'p' },
      { id: 'addAnchor', name: 'Add Anchor Point Tool', icon: 'addAnchor' },
      { id: 'deleteAnchor', name: 'Delete Anchor Point Tool', icon: 'deleteAnchor' },
      { id: 'convertPoint', name: 'Convert Point Tool', icon: 'convertPoint' },
    ],
  },
  {
    id: 'type',
    key: 't',
    tools: [
      { id: 'typeHorizontal', name: 'Horizontal Type Tool', icon: 'type', key: 't' },
      { id: 'typeVertical', name: 'Vertical Type Tool', icon: 'typeVertical', key: 't' },
      { id: 'typeMaskVertical', name: 'Vertical Type Mask Tool', icon: 'typeMask', key: 't' },
      { id: 'typeMaskHorizontal', name: 'Horizontal Type Mask Tool', icon: 'typeMask', key: 't' },
    ],
  },
  {
    id: 'pathSelect',
    key: 'a',
    tools: [
      { id: 'pathSelect', name: 'Path Selection Tool', icon: 'pathSelect', key: 'a' },
      { id: 'directSelect', name: 'Direct Selection Tool', icon: 'directSelect', key: 'a' },
    ],
  },
  {
    id: 'shape',
    key: 'u',
    tools: [
      { id: 'rectangle', name: 'Rectangle Tool', icon: 'rectangle', key: 'u' },
      { id: 'ellipse', name: 'Ellipse Tool', icon: 'ellipse', key: 'u' },
      { id: 'triangle', name: 'Triangle Tool', icon: 'triangle', key: 'u' },
      { id: 'polygon', name: 'Polygon Tool', icon: 'polygon', key: 'u' },
      { id: 'line', name: 'Line Tool', icon: 'line', key: 'u' },
      { id: 'customShape', name: 'Custom Shape Tool', icon: 'customShape', key: 'u' },
    ],
  },
  {
    id: 'view',
    key: 'h',
    tools: [
      { id: 'hand', name: 'Hand Tool', icon: 'hand', key: 'h', implemented: true, hint: 'Drag to pan. Hold Space with any tool.' },
      { id: 'rotateView', name: 'Rotate View Tool', icon: 'rotateView', key: 'r', implemented: true },
    ],
  },
  {
    id: 'zoom',
    key: 'z',
    tools: [{ id: 'zoom', name: 'Zoom Tool', icon: 'zoom', key: 'z', implemented: true, hint: 'Click to zoom in. Alt-click to zoom out.' }],
  },
];

export const ALL_TOOLS: ToolDef[] = TOOL_GROUPS.flatMap((g) => g.tools);
export const TOOL_BY_ID = new Map(ALL_TOOLS.map((t) => [t.id, t]));

export function groupOf(toolId: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((g) => g.tools.some((t) => t.id === toolId));
}

/** Tools sharing a shortcut letter, in cycle order (Shift+letter steps through them). */
export function cycleForKey(key: string): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.key === key);
}

/** Paint-like tools use the brush cursor and brush options. */
export const PAINT_TOOLS = new Set([
  'brush',
  'pencil',
  'colorReplacement',
  'mixerBrush',
  'eraser',
  'backgroundEraser',
  'cloneStamp',
  'patternStamp',
  'historyBrush',
  'artHistoryBrush',
  'blurTool',
  'sharpenTool',
  'smudgeTool',
  'dodgeTool',
  'burnTool',
  'spongeTool',
  'spotHealing',
  'healingBrush',
  'selectionBrush',
]);
