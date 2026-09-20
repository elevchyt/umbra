/**
 * Panel metadata — spec 01 §4.
 *
 * Kept apart from the panel components: this is plain data (ids, titles, icons) that the dock,
 * the Window menu and the workspace presets all need, and importing it must not drag in the
 * Solid components, which touch the DOM at module load.
 */
import type { PanelMeta } from '@umbra/ui/dock/Dock';

export const PANEL_META: Record<string, PanelMeta> = {
  layers: { title: 'Layers', icon: 'newLayer' },
  channels: { title: 'Channels', icon: 'adjustment' },
  paths: { title: 'Paths', icon: 'pen' },
  properties: { title: 'Properties', icon: 'gear' },
  adjustments: { title: 'Adjustments', icon: 'adjustment' },
  color: { title: 'Color', icon: 'eyedropper' },
  swatches: { title: 'Swatches', icon: 'grid' },
  gradients: { title: 'Gradients', icon: 'gradient' },
  patterns: { title: 'Patterns', icon: 'grid' },
  brushes: { title: 'Brushes', icon: 'brush' },
  brushSettings: { title: 'Brush Settings', icon: 'brush' },
  history: { title: 'History', icon: 'historyBrush' },
  navigator: { title: 'Navigator', icon: 'zoom' },
  info: { title: 'Info', icon: 'colorSampler' },
  histogram: { title: 'Histogram', icon: 'filterRows' },
  actions: { title: 'Actions', icon: 'gear' },
  character: { title: 'Character', icon: 'type' },
  paragraph: { title: 'Paragraph', icon: 'filterRows' },
  characterStyles: { title: 'Character Styles', icon: 'type' },
  paragraphStyles: { title: 'Paragraph Styles', icon: 'filterRows' },
  glyphs: { title: 'Glyphs', icon: 'type' },
  styles: { title: 'Styles', icon: 'fx' },
  shapes: { title: 'Shapes', icon: 'customShape' },
  toolPresets: { title: 'Tool Presets', icon: 'gear' },
  layerComps: { title: 'Layer Comps', icon: 'snapshot' },
  cloneSource: { title: 'Clone Source', icon: 'cloneStamp' },
  notes: { title: 'Notes', icon: 'note' },
  timeline: { title: 'Timeline', icon: 'filterRows' },
};

/** Window-menu command id → panel id. */
export const PANEL_BY_COMMAND: Record<string, string> = Object.fromEntries(
  Object.keys(PANEL_META).map((id) => [`panel.${id}`, id]),
);
