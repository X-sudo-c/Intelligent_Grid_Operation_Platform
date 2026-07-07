import type { GiopTopologyPayload } from '../api/giop-api';
import type { GiopPortalTab } from '../lib/giopPortalRouting';
import type { FeederHighlightGeoJson } from '../lib/giopFeederHighlight';
import type { TerritoryGeoJson } from '../lib/giopTerritoryHighlight';
import type { CopilotStructuredContent } from './giopCopilotMessageContent';

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
      max_zoom?: number;
    }
  | {
      type: 'fly_to';
      tab?: GiopPortalTab | string;
      center: { lon: number; lat: number };
      zoom?: number;
      /** MapLibre fly duration ms — use shorter values for snappy relative zoom. */
      duration?: number;
    }
  | {
      type: 'highlight_territory';
      tab?: GiopPortalTab | string;
      bbox: MapBboxContext;
      district?: string;
      region?: string;
      label?: string;
      geojson?: TerritoryGeoJson;
    }
  | {
      type: 'highlight_feeder';
      tab?: GiopPortalTab | string;
      feeder_id: string;
      label?: string;
      bbox?: MapBboxContext;
      geojson: FeederHighlightGeoJson;
    }
  | {
      type: 'highlight_node';
      tab?: GiopPortalTab | string;
      mrid: string;
      label?: string;
      center: { lon: number; lat: number };
      zoom?: number;
      /** Amber pulse — AI is guessing which node the user means. */
      tentative?: boolean;
    }
  | {
      type: 'show_downstream_impact';
      tab?: GiopPortalTab | string;
      start_mrid: string;
      label?: string;
      impact: GiopTopologyPayload;
      bbox?: MapBboxContext;
    };

/** Human-readable "here's what I did" line for a UI action the copilot ran. */
export function describeCopilotUiAction(action: GiopCopilotUiAction): string {
  switch (action.type) {
    case 'navigate':
      return action.focus_mrid
        ? `Opened the ${action.tab} tab and focused the asset`
        : `Opened the ${action.tab} tab`;
    case 'fit_bounds': {
      const where = action.district ?? action.region;
      return where ? `Framed ${where} on the map` : 'Framed the area on the map';
    }
    case 'fly_to':
      return 'Moved the map to the location';
    case 'highlight_territory':
      return `Highlighted ${action.label ?? action.district ?? action.region ?? 'the territory'} on the map`;
    case 'highlight_feeder':
      return `Highlighted feeder ${action.label ?? action.feeder_id} on the map`;
    case 'highlight_node':
      return action.tentative
        ? `Highlighted ${action.label ?? 'a node'} on the map for confirmation`
        : `Highlighted ${action.label ?? 'the node'} on the map`;
    case 'show_downstream_impact':
      return `Showed downstream impact from ${action.label ?? 'the selected node'} on the map`;
    default:
      return 'Updated the map';
  }
}

export interface GiopCopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  findings?: string[];
  actions?: string[];
  uiActions?: GiopCopilotUiAction[];
  pending?: boolean;
  pendingQuery?: string;
  requestId?: string;
  structured?: CopilotStructuredContent;
}

export interface GiopCopilotPortalContext {
  active_tab: GiopPortalTab;
  focus_mrid?: string | null;
  selection_name?: string | null;
  boundary_feeder_id?: string | null;
  staging_pending_count?: number;
  viewport?: MapViewportContext | null;
  selected_district?: string | null;
  selected_region?: string | null;
}

export const COPILOT_SUGGESTIONS = [
  'How many poles are in the current map view?',
  'What work orders are in view?',
  'Tell me about the node in view',
  'Show connections on the Mallam feeder',
  'How many staging captures in this district?',
  'Highlight Accra on the map',
  'Show nodes on this feeder',
  "What's downstream from this node?",
] as const;
