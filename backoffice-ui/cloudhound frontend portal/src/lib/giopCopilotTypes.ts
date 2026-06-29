import type { GiopPortalTab } from '../lib/giopPortalRouting';
import type { TerritoryGeoJson } from '../lib/giopTerritoryHighlight';

export interface MapBboxContext {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapViewportContext {
  bbox: MapBboxContext;
  zoom: number;
  center: { lon: number; lat: number };
}

export type GiopCopilotUiAction =
  | {
      type: 'navigate';
      tab: GiopPortalTab | string;
      focus_mrid?: string;
      region?: string;
      district?: string;
    }
  | {
      type: 'fit_bounds';
      tab?: GiopPortalTab | string;
      bbox: MapBboxContext;
      district?: string;
      region?: string;
    }
  | {
      type: 'fly_to';
      tab?: GiopPortalTab | string;
      center: { lon: number; lat: number };
      zoom?: number;
    }
  | {
      type: 'highlight_territory';
      tab?: GiopPortalTab | string;
      bbox: MapBboxContext;
      district?: string;
      region?: string;
      label?: string;
      geojson?: TerritoryGeoJson;
    };

export interface GiopCopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  findings?: string[];
  actions?: string[];
  uiActions?: GiopCopilotUiAction[];
  pending?: boolean;
}

export interface GiopCopilotPortalContext {
  active_tab: GiopPortalTab;
  focus_mrid?: string | null;
  selection_name?: string | null;
  staging_pending_count?: number;
  viewport?: MapViewportContext | null;
  selected_district?: string | null;
  selected_region?: string | null;
}

export const COPILOT_SUGGESTIONS = [
  'How many poles are in the current map view?',
  'How many staging captures in this district?',
  'Highlight Accra on the map',
  'Show staging counts by district',
] as const;
