import { useEffect, useMemo, useRef, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { CloudHoundAIChatResponse, CloudHoundPolicyDocumentResponse, CloudHoundPortalGraphResponse } from '../api/giopGraphStubs';
import { GIOP_GRAPH_QUERY_OPTIONS, type GiopGraphQueryKey } from '../lib/giopGraphTypes';
import { findCloudHoundPath, getCloudHoundPolicyDocument, type CloudHoundPathFindingResponse } from '../api/giopGraphStubs';
import { voltageEdgeColor } from '../lib/giopSldTheme';
import { computeGraphQuality, GRAPH_QUALITY, isOnScreen } from '../lib/giopGraphPerf';
import { Lock, GitBranch, Sparkles } from 'lucide-react';
import { AssistantRichText } from './AssistantRichText';

interface GiopGraphCanvasProps {
  graph: CloudHoundPortalGraphResponse;
  isAdmin?: boolean;
  selectedAwsAccountId?: string;
  isLightMode?: boolean;
  focusNodeArn?: string | null;
  onFocusNodeHandled?: () => void;
  onNodeSelect?: (mrid: string, label?: string) => void;
  onRequestAiAssist?: (request: { nodeId: string; nodeTitle: string; prompt: string }) => void;
  onRequestGraphAiMode?: () => void;
  aiAssist?: GraphAiAssistPanelState;
  /** Minimal grid topology UI for the FR-010 operations desk (no IAM chrome). */
  graphChrome?: 'full' | 'operations';
  graphQuery?: GiopGraphQueryKey;
  onQueryChange?: (key: GiopGraphQueryKey) => void;
  graphQueryOptions?: typeof GIOP_GRAPH_QUERY_OPTIONS;
}

const OPS_QUERY_LABELS: Partial<Record<GiopGraphQueryKey, string>> = {
  traced_subgraph: 'Traced',
  network_topology: 'Full network',
};

type GraphAiProposal = NonNullable<CloudHoundAIChatResponse['remediation_proposals']>[number];

interface GraphAiAssistMessage {
  role: 'user' | 'assistant';
  content: string;
  findings?: string[];
  actions?: string[];
  suggestionPrompts?: string[];
  modeSuggestions?: Array<{ mode: 'graph' | 'graph_chat'; label: string }>;
  remediationProposals?: GraphAiProposal[];
  agent?: {
    provider?: string;
    model?: string;
    iterations?: number;
    toolsUsed?: string[];
    auto?: boolean;
    fallbackChain?: Array<{
      provider: string;
      model: string;
      status: 'ok' | 'error';
      error?: string;
    }>;
  };
}

interface GraphAiAssistPanelState {
  isOpen: boolean;
  mode: 'node' | 'graph' | 'graph_chat';
  nodeId: string | null;
  nodeTitle: string;
  draft: string;
  loading: boolean;
  messages: GraphAiAssistMessage[];
  lastInstruction?: string;
  applyingProposalId?: string;
  appliedProposalIds: Set<string>;
  canApplyProposals: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onSwitchMode?: (mode: 'graph' | 'graph_chat') => void;
  onClose: () => void;
  onApplyProposal: (proposal: GraphAiProposal) => void | Promise<void>;
}

interface PolicySummaryRecord {
  statement_count?: number;
  allow_actions?: string[];
  deny_actions?: string[];
  allow_resources?: string[];
  deny_resources?: string[];
  has_wildcard_actions?: boolean;
  has_wildcard_resources?: boolean;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  node: NodeRecord | null;
}

interface EmptySpaceActionMenuState {
  visible: boolean;
  x: number;
  y: number;
}

type Filter = 'all' | 'substation' | 'transformer' | 'feeder' | 'meter' | 'other';
type RiskBand = 'critical' | 'high' | 'medium' | 'low';
type NodeRecord = {
  id: string;
  label: string;
  fullLabel: string;
  category: Filter;
  nodeType: string;
  riskLevel: number;
  riskBand: RiskBand;
  graphSignalLevel: number;
  riskColor: string | null;
  arn: string;
  tags: string[];
  properties: Record<string, unknown>;
  size: number;
  color: string;
  isHvt: boolean;
  trustExternal: boolean;
  dangerousPolicy: boolean;
};
type EdgeRecord = {
  id: string;
  source: string;
  target: string;
  label: string;
  weight: number;
  confidence: number;
  color: string;
  isPrivilegeEscalation: boolean;
  escalationType?: string;
  chainExplanation?: string;
};
type Camera = { x: number; y: number; zoom: number };
type SimNode = SimulationNodeDatum & NodeRecord & { fx?: number | null; fy?: number | null; drift: number; driftSpeed: number; driftRadius: number };
type SimLink = SimulationLinkDatum<SimNode> & { source: string | SimNode; target: string | SimNode; weight: number; label: string; confidence: number; color: string; isPrivilegeEscalation: boolean; escalationType?: string; chainExplanation?: string };
type AiAssistAnchor = { nodeX: number; nodeY: number; bubbleX: number; bubbleY: number; visible: boolean };

const COLORS: Record<Filter, string> = {
  all: '#9aa4b3',
  substation: '#9ec5ff',
  transformer: '#c9a9ff',
  feeder: '#7fd6c9',
  meter: '#ffd08a',
  other: '#9aa4b3',
};

const RISK_COLORS: Record<RiskBand, string | null> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#f59e0b',
  low: null,
};

function normalizeRiskBand(value: unknown, score: number): RiskBand {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'critical' || raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (score >= 85) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

const EDGE_COLORS: Record<string, string> = {
  AC_LINE_SEGMENT: 'rgba(127,214,201,0.72)',
  MV_11KV: 'rgba(37,99,235,0.72)',
  LV_400V: 'rgba(34,197,94,0.72)',
  HV: 'rgba(168,129,255,0.72)',
  RELATES_TO: 'rgba(154,164,179,0.58)',
  TOPOLOGY_GAP: 'rgba(239, 68, 68, 0.82)',
  PRIVILEGE_ESCALATION: 'rgba(239, 68, 68, 0.82)',
};

function edgeColor(relationshipType: string, isPrivilegeEscalation: boolean, voltage?: string): string {
  if (isPrivilegeEscalation) return EDGE_COLORS.PRIVILEGE_ESCALATION;
  if (voltage) return voltageEdgeColor(voltage);
  const key = relationshipType.toUpperCase();
  return EDGE_COLORS[key] ?? voltageEdgeColor(relationshipType) ?? 'rgba(154,164,179,0.58)';
}

function vibrantEdgeColor(color: string): string {
  const rgba = color.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)/i);
  if (!rgba) return color;
  const r = Number(rgba[1]);
  const g = Number(rgba[2]);
  const b = Number(rgba[3]);
  const a = rgba[4] ? Number(rgba[4]) : 1;

  const lift = (v: number) => Math.min(255, Math.round(v + (255 - v) * 0.28));
  const boost = (v: number) => Math.min(255, Math.round(lift(v) * 1.08));

  return `rgba(${boost(r)}, ${boost(g)}, ${boost(b)}, ${Math.min(1, Math.max(0.92, a + 0.2)).toFixed(2)})`;
}

const FORCE_PREFS_KEY = 'cloudhound.graph.forcePrefs.v1';
const CAMERA_PREFS_KEY = 'cloudhound.graph.camera.v1';
const CAMERA_MIN_ZOOM = 0.05;
const CAMERA_MAX_ZOOM = 4.8;

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function readForcePrefs() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FORCE_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{ repelForce: number; linkStrength: number; linkDist: number; centerForce: number }>;
    return {
      repelForce: clamp(Number(parsed.repelForce ?? 0.4), 0, 1.5),
      linkStrength: clamp(Number(parsed.linkStrength ?? 0.5), 0, 1),
      linkDist: clamp(Number(parsed.linkDist ?? 60), 10, 300),
      centerForce: clamp(Number(parsed.centerForce ?? 0.1), 0, 1.25),
    };
  } catch {
    return null;
  }
}
function readableLabel(node: { label?: string; name?: string; arn?: string; id: string }) { const text = node.name || node.label || node.arn || node.id; return text.length > 42 ? `${text.slice(0, 39)}...` : text; }
function categoryOf(type?: string, label?: string): Filter {
  const raw = `${type || ''} ${label || ''}`.toLowerCase();
  if (raw.includes('substation') || raw.includes('bsp')) return 'substation';
  if (raw.includes('transformer') || raw.includes(' tx')) return 'transformer';
  if (raw.includes('feeder')) return 'feeder';
  if (raw.includes('meter')) return 'meter';
  return 'other';
}
function edgeWeight(label: string) {
  const lower = label.toLowerCase();
  if (lower.includes('mv') || lower.includes('hv')) return 1.6;
  if (lower.includes('lv')) return 1.2;
  if (lower.includes('line') || lower.includes('segment')) return 1.3;
  return 1;
}
function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function matchesSearchQuery(parts: Array<string | undefined | null>, query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  const haystack = normalizeSearchText(parts.filter(Boolean).join(' '));
  if (!haystack) return false;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token));
}
function searchRelevanceScore(parts: Array<string | undefined | null>, query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const haystack = normalizeSearchText(parts.filter(Boolean).join(' '));
  if (!haystack) return 0;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;

  let score = 0;
  if (haystack === normalizedQuery) score += 600;
  if (haystack.startsWith(normalizedQuery)) score += 300;
  if (haystack.includes(normalizedQuery)) score += 200;

  const paddedHaystack = ` ${haystack} `;
  tokens.forEach((token) => {
    if (!haystack.includes(token)) return;
    if (haystack.startsWith(token)) score += 45;
    if (paddedHaystack.includes(` ${token} `)) score += 30;
    else score += 15;

    const idx = haystack.indexOf(token);
    if (idx >= 0) {
      score += Math.max(0, 25 - Math.min(25, idx));
    }
  });

  return score;
}
function nodeSize(node: NodeRecord, degree: number = 0) {
  const riskBase = 3.2 + Math.min(20, Math.round(node.riskLevel / 5)) * 0.2;
  const connectivityBoost = Math.min(4.8, Math.log2(Math.max(1, degree) + 1) * 1.35);
  return Math.max(3, riskBase + connectivityBoost);
}
function edgeKey(id: string | undefined, source: string, target: string, label: string, index: number) { return (id || '').trim() || `${source}::${target}::${label}::${index}`; }
function screen(node: SimNode, camera: Camera, width: number, height: number) { return { x: ((node.x ?? 0) - camera.x) * camera.zoom + width / 2, y: ((node.y ?? 0) - camera.y) * camera.zoom + height / 2 }; }
function graphPoint(screenX: number, screenY: number, camera: Camera, width: number, height: number) { return { x: (screenX - width / 2) / camera.zoom + camera.x, y: (screenY - height / 2) / camera.zoom + camera.y }; }
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, fill: string, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawUserGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, active: boolean) {
  const headRadius = Math.max(1.5, radius * 0.22);
  const bodyWidth = Math.max(3, radius * 0.8);
  const bodyY = y + radius * 0.18;
  ctx.save();
  ctx.strokeStyle = active ? 'rgba(15, 23, 42, 0.95)' : 'rgba(7, 11, 23, 0.85)';
  ctx.lineWidth = Math.max(1.2, radius * 0.12);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Head
  ctx.beginPath();
  ctx.arc(x, y - radius * 0.25, headRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Shoulders/body arc
  ctx.beginPath();
  ctx.arc(x, bodyY, bodyWidth * 0.5, Math.PI * 0.12, Math.PI * 0.88);
  ctx.stroke();
  ctx.restore();
}

function readCameraPrefs(): Camera | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CAMERA_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Camera>;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    const zoom = clamp(Number(parsed.zoom), CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
    return { x, y, zoom };
  } catch {
    return null;
  }
}

function writeCameraPrefs(camera: Camera) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify(camera));
  } catch {
    // Ignore storage failures and continue rendering.
  }
}

export function GiopGraphCanvas({ graph, isAdmin = false, selectedAwsAccountId = '', isLightMode = false, focusNodeArn = null, onFocusNodeHandled, onNodeSelect, onRequestAiAssist, onRequestGraphAiMode, aiAssist, graphChrome = 'full', graphQuery, onQueryChange, graphQueryOptions }: GiopGraphCanvasProps) {
  const isOpsChrome = graphChrome === 'operations';
  const opsQueryOptions = isOpsChrome ? graphQueryOptions : undefined;
  const initialForcePrefs = readForcePrefs();
  const graphShellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode, SimLink>> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimLink[]>([]);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const cameraTargetRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const modeRef = useRef<'none' | 'pan' | 'node'>('none');
  const startRef = useRef({ x: 0, y: 0 });
  const searchRef = useRef('');
  const activeRef = useRef<string | null>(null);
  const hoverStateRef = useRef<string | null>(null);
  const filterRef = useRef<Set<Filter>>(new Set<Filter>());
  const depthRef = useRef(2);
  const showArrowsRef = useRef(true);
  const heatMapEnabledRef = useRef(false);
  const textFadeZoomRef = useRef(1.4);
  const nodeSizeMultRef = useRef(1.0);
  const linkThicknessRef = useRef(1.0);
  const edgeVisibilityRef = useRef(1.0);
  const forceParamsRef = useRef({ repel: -100, linkDist: 60, linkStr: 0.5 });
  const lastAutoFocusKeyRef = useRef('');
  const lastAiQueryFocusKeyRef = useRef('');
  const searchBestIdRef = useRef<string | null>(null);
  const searchFocusUntilRef = useRef(0);
  const filterFocusUntilRef = useRef(0);
  const lastCameraPersistAtRef = useRef(0);
  const pathFindingEnabledRef = useRef(false);
  const pathFindingStartRef = useRef<NodeRecord | null>(null);
  const pathFindingEndRef = useRef<NodeRecord | null>(null);
  const pathRequestSeqRef = useRef(0);
  const lightModeRef = useRef(false);
  const selectedAwsAccountIdRef = useRef(selectedAwsAccountId);
  const previousAiAssistOpenRef = useRef(false);
  const animationTimeRef = useRef(0);
  const aiAssistRef = useRef(aiAssist);
  const onNodeSelectRef = useRef(onNodeSelect);
  const pointerMovedRef = useRef(false);

  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchCommitTick, setSearchCommitTick] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedFilters, setSelectedFilters] = useState<Set<Filter>>(new Set<Filter>());
  const [depth, setDepth] = useState(2);
  const [animating, setAnimating] = useState(false);
  // Settings panel state
  const [showArrows, setShowArrows] = useState(true);
  const [heatMapEnabled, setHeatMapEnabled] = useState(false);
  // Lower default so labels only hide when extremely zoomed out
  const [textFadeZoom, setTextFadeZoom] = useState(0.3);
  const [nodeSizeMult, setNodeSizeMult] = useState(1.0);
  const [linkThickness, setLinkThickness] = useState(1.0);
  const [edgeVisibility, setEdgeVisibility] = useState(1.0);
  const [repelForce, setRepelForce] = useState(initialForcePrefs?.repelForce ?? 0.4);
  const [linkStrength, setLinkStrength] = useState(initialForcePrefs?.linkStrength ?? 0.5);
  const [linkDist, setLinkDist] = useState(initialForcePrefs?.linkDist ?? 60);
  const [centerForce, setCenterForce] = useState(initialForcePrefs?.centerForce ?? 0.1);
  const [displaySectionOpen, setDisplaySectionOpen] = useState(true);
  const [forcesSectionOpen, setForcesSectionOpen] = useState(false);
  const [controlsPanelOpen, setControlsPanelOpen] = useState(false);
  const [policyDocument, setPolicyDocument] = useState<CloudHoundPolicyDocumentResponse | null>(null);
  const [policyDocumentLoading, setPolicyDocumentLoading] = useState(false);
  const [policyDocumentError, setPolicyDocumentError] = useState<string | null>(null);
  
  // Context menu state for IAM actions
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, node: null });
  const [emptySpaceMenu, setEmptySpaceMenu] = useState<EmptySpaceActionMenuState>({ visible: false, x: 0, y: 0 });

  // Path finding state
  const [pathFindingEnabled, setPathFindingEnabled] = useState(false);
  const [pathFindingStart, setPathFindingStart] = useState<NodeRecord | null>(null);
  const [pathFindingEnd, setPathFindingEnd] = useState<NodeRecord | null>(null);
  const [foundPath, setFoundPath] = useState<CloudHoundPathFindingResponse | null>(null);
  const [pathFindingLoading, setPathFindingLoading] = useState(false);
  const [aiAssistAnchor, setAiAssistAnchor] = useState<AiAssistAnchor>({ nodeX: 0, nodeY: 0, bubbleX: 0, bubbleY: 0, visible: false });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const aiAssistAnchorRef = useRef<AiAssistAnchor>({ nodeX: 0, nodeY: 0, bubbleX: 0, bubbleY: 0, visible: false });

  useEffect(() => {
    if (!contextMenu.visible && !emptySpaceMenu.visible) return;

    const closeMenus = () => {
      setContextMenu({ visible: false, x: 0, y: 0, node: null });
      setEmptySpaceMenu({ visible: false, x: 0, y: 0 });
    };

    const onDocPointerDown = () => closeMenus();
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenus();
      }
    };

    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [contextMenu.visible, emptySpaceMenu.visible]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === graphShellRef.current);
    };

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
    };
  }, []);

  useEffect(() => { searchRef.current = searchInput; }, [searchInput]);
  useEffect(() => { activeRef.current = activeId; }, [activeId]);
  useEffect(() => { hoverStateRef.current = hoverId; hoverRef.current = hoverId; }, [hoverId]);
  useEffect(() => { filterRef.current = selectedFilters; }, [selectedFilters]);
  useEffect(() => { depthRef.current = depth; }, [depth]);
  useEffect(() => { showArrowsRef.current = showArrows; }, [showArrows]);
  useEffect(() => { heatMapEnabledRef.current = heatMapEnabled; }, [heatMapEnabled]);
  useEffect(() => { textFadeZoomRef.current = textFadeZoom; }, [textFadeZoom]);
  useEffect(() => { nodeSizeMultRef.current = nodeSizeMult; }, [nodeSizeMult]);
  useEffect(() => { linkThicknessRef.current = linkThickness; }, [linkThickness]);
  useEffect(() => { edgeVisibilityRef.current = edgeVisibility; }, [edgeVisibility]);
  useEffect(() => { pathFindingEnabledRef.current = pathFindingEnabled; }, [pathFindingEnabled]);
  useEffect(() => { pathFindingStartRef.current = pathFindingStart; }, [pathFindingStart]);
  useEffect(() => { pathFindingEndRef.current = pathFindingEnd; }, [pathFindingEnd]);
  useEffect(() => { lightModeRef.current = isLightMode; }, [isLightMode]);
  useEffect(() => { selectedAwsAccountIdRef.current = selectedAwsAccountId; }, [selectedAwsAccountId]);
  useEffect(() => { aiAssistRef.current = aiAssist; }, [aiAssist]);
  useEffect(() => { onNodeSelectRef.current = onNodeSelect; }, [onNodeSelect]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      FORCE_PREFS_KEY,
      JSON.stringify({ repelForce, linkStrength, linkDist, centerForce }),
    );
  }, [repelForce, linkStrength, linkDist, centerForce]);
  useEffect(() => {
    // Use stronger mappings so slider movement yields obvious layout changes.
    const mappedRepel = -(80 + repelForce * 650);
    const mappedLinkDist = 20 + linkDist * 1.15;
    const mappedLinkStrength = 0.04 + linkStrength * 1.65;
    forceParamsRef.current = { repel: mappedRepel, linkDist: mappedLinkDist, linkStr: mappedLinkStrength };

    const simulation = simRef.current;
    if (simulation) {
      const nodeCount = Math.max(90, nodesRef.current.length || 90);
      const densityFactor = Math.min(1.2, 240 / nodeCount);

      const chargeForce = simulation.force('charge') as any;
      if (chargeForce?.strength) {
        chargeForce
          .strength((node: SimNode) => mappedRepel * densityFactor * (1 + node.size * 0.02))
          .distanceMin(10)
          .distanceMax(nodesRef.current.length > 2400 ? 140 : 180)
          .theta(0.86);
      }

      const linkForce = simulation.force('link') as any;
      if (linkForce?.distance && linkForce?.strength) {
        linkForce
          .distance((link: SimLink) => mappedLinkDist + (2 - Math.min(2, link.weight)) * 6)
          .strength((link: SimLink) => Math.max(0.02, Math.min(1.85, mappedLinkStrength + Math.min(0.22, link.weight * 0.1))));
      }

      simulation
        .force('centerX', forceX(0).strength(centerForce * 0.35))
        .force('centerY', forceY(0).strength(centerForce * 0.35))
        .alpha(0.82)
        .restart();
    }
  }, [repelForce, linkDist, linkStrength, centerForce]);

  const renderGraph = useMemo(() => {
    const degreeCounts = new Map<string, number>();
    (graph.edges || []).forEach((edge) => {
      degreeCounts.set(edge.source, (degreeCounts.get(edge.source) || 0) + 1);
      degreeCounts.set(edge.target, (degreeCounts.get(edge.target) || 0) + 1);
    });

    const nodes: NodeRecord[] = (graph.nodes || []).map((n) => {
      const category = categoryOf(n.type, n.label);
      const properties = n.properties || {};
      const riskLevel = Number(
        n.findings_risk_score
        ?? properties.findings_risk_score
        ?? n.risk_level
        ?? 0,
      );
      const riskBand = normalizeRiskBand(
        n.findings_risk_band ?? properties.findings_risk_band ?? n.risk_band,
        riskLevel,
      );
      const graphSignalLevel = Number(properties.graph_signal_level ?? n.graph_signal_level ?? 0);
      const degree = degreeCounts.get(n.id) || 0;
      const fullLabel = n.name || n.label || n.arn || n.id;
      const label = readableLabel({ ...n, id: n.id });
      const isHvt = properties.is_hvt === true;
      const trustExternal =
        properties.trust_external === true
        || properties.disconnected === true
        || properties.connected === false;
      const dangerousPolicy = properties.dangerous_policy === true || properties.is_conflict === true;
      const tags = [
        n.type,
        category,
        riskBand,
        graphSignalLevel > 0 ? 'graph-signal' : null,
        isHvt ? 'critical-asset' : null,
        trustExternal ? 'disconnected' : null,
        dangerousPolicy ? 'in-conflict' : null,
      ].filter(Boolean).map((value) => String(value).toLowerCase());
      const riskColor = RISK_COLORS[riskBand];
      return {
        id: n.id,
        label,
        fullLabel,
        category,
        nodeType: (n.type || n.label || 'entity').toLowerCase(),
        riskLevel,
        riskBand,
        graphSignalLevel,
        arn: n.arn || '',
        tags,
        properties,
        size: nodeSize({
          id: n.id,
          label,
          fullLabel,
          category,
          nodeType: 'x',
          riskLevel,
          riskBand,
          graphSignalLevel,
          riskColor,
          arn: '',
          tags,
          properties: {},
          size: 0,
          color: '',
          isHvt,
          trustExternal,
          dangerousPolicy,
        }, degree),
        color: COLORS[category],
        riskColor,
        isHvt,
        trustExternal,
        dangerousPolicy,
      };
    });
    const edges: EdgeRecord[] = (graph.edges || []).map((e, index) => {
      const label = e.relationship_type || 'RELATES_TO';
      const weight = edgeWeight(label);
      const isPrivilegeEscalation =
        e.properties?.is_privilege_escalation === true
        || e.properties?.is_topology_gap === true
        || e.properties?.is_conflict === true;
      const escalationType = typeof e.properties?.escalation_type === 'string' ? e.properties.escalation_type : undefined;
      const chainExplanation = typeof e.properties?.chain_explanation === 'string' ? e.properties.chain_explanation : undefined;
      const voltage = typeof e.properties?.voltage === 'string' ? e.properties.voltage : undefined;
      return {
        id: edgeKey(e.id, e.source, e.target, label, index),
        source: e.source,
        target: e.target,
        label,
        weight,
        confidence: Math.max(0.45, Math.min(1, 0.6 + weight / 4)),
        color: edgeColor(label, isPrivilegeEscalation, voltage),
        isPrivilegeEscalation,
        escalationType,
        chainExplanation,
      };
    });
    return { nodes, edges };
  }, [graph]);

  const nodeById = useMemo(() => {
    const map = new Map<string, NodeRecord>();
    renderGraph.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [renderGraph.nodes]);

  const adjacency = useMemo(() => {
    const neighbors = new Map<string, Set<string>>();
    const nodeEdges = new Map<string, Set<string>>();
    renderGraph.edges.forEach((edge) => {
      if (!neighbors.has(edge.source)) neighbors.set(edge.source, new Set());
      if (!neighbors.has(edge.target)) neighbors.set(edge.target, new Set());
      if (!nodeEdges.has(edge.source)) nodeEdges.set(edge.source, new Set());
      if (!nodeEdges.has(edge.target)) nodeEdges.set(edge.target, new Set());
      neighbors.get(edge.source)?.add(edge.target);
      neighbors.get(edge.target)?.add(edge.source);
      nodeEdges.get(edge.source)?.add(edge.id);
      nodeEdges.get(edge.target)?.add(edge.id);
    });
    return { neighbors, nodeEdges };
  }, [renderGraph.edges]);

  const typeCounts = useMemo(() => {
    const counts: Record<Filter, number> = { all: renderGraph.nodes.length, substation: 0, transformer: 0, feeder: 0, meter: 0, other: 0 };
    renderGraph.nodes.forEach((node) => { counts[node.category] += 1; });
    return counts;
  }, [renderGraph.nodes]);

  const searchMatches = useMemo(() => {
    const query = searchInput.trim();
    // If no search, just filter by selectedFilters
    if (!query) {
      if (selectedFilters.size === 0) return renderGraph.nodes;
      return renderGraph.nodes.filter((node) => selectedFilters.has(node.category));
    }
    // Filter nodes by selectedFilters before applying search
    const filteredNodes = selectedFilters.size === 0
      ? renderGraph.nodes
      : renderGraph.nodes.filter((node) => selectedFilters.has(node.category));
    return filteredNodes
      .map((node) => ({
        node,
        score: matchesSearchQuery([node.label, node.fullLabel, node.nodeType, node.arn, node.category, ...node.tags], query)
          ? searchRelevanceScore([node.label, node.fullLabel, node.nodeType, node.arn, node.category, ...node.tags], query)
          : 0,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.node);
  }, [renderGraph.nodes, searchInput, selectedFilters]);

  const committedSearchMatches = useMemo(() => {
    const query = search.trim();
    // If no search, just filter by selectedFilters
    if (!query) {
      if (selectedFilters.size === 0) return renderGraph.nodes;
      return renderGraph.nodes.filter((node) => selectedFilters.has(node.category));
    }
    // Filter nodes by selectedFilters before applying search
    const filteredNodes = selectedFilters.size === 0
      ? renderGraph.nodes
      : renderGraph.nodes.filter((node) => selectedFilters.has(node.category));
    return filteredNodes
      .map((node) => ({
        node,
        score: matchesSearchQuery([node.label, node.fullLabel, node.nodeType, node.arn, node.category, ...node.tags], query)
          ? searchRelevanceScore([node.label, node.fullLabel, node.nodeType, node.arn, node.category, ...node.tags], query)
          : 0,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.node);
  }, [renderGraph.nodes, search, selectedFilters]);

  useEffect(() => {
    // Move the best live match into focus as the user types. The actual camera
    // glide is handled per-frame in the render loop (which always has fresh node
    // positions); here we just nominate the target node and open the focus
    // window so the loop knows to follow it.
    const query = searchInput.trim();
    if (!query) {
      searchBestIdRef.current = null;
      lastAutoFocusKeyRef.current = '';
      return;
    }

    const bestMatch = searchMatches[0];
    searchBestIdRef.current = bestMatch ? bestMatch.id : null;
    if (!bestMatch) return;

    setActiveId(bestMatch.id);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    searchFocusUntilRef.current = now + 1800;
  }, [searchInput, searchMatches, searchCommitTick]);

  useEffect(() => {
    const hasCommittedSearch = !!search.trim();
    const hasFilter = selectedFilters.size > 0;
    if (!hasCommittedSearch && hasFilter) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      // Keep reframing briefly while force layout settles so filtered nodes stay in view.
      filterFocusUntilRef.current = now + 2600;
      return;
    }
    filterFocusUntilRef.current = 0;
  }, [selectedFilters, search]);

  const focusId = hoverId || activeId || searchMatches[0]?.id || null;
  const selectedNode = useMemo(() => (focusId ? renderGraph.nodes.find((node) => node.id === focusId) || null : null), [focusId, renderGraph.nodes]);
  const hoverNode = useMemo(
    () => (hoverId ? renderGraph.nodes.find((node) => node.id === hoverId) || null : null),
    [hoverId, renderGraph.nodes],
  );
  const relatedNodes = useMemo(() => {
    if (!focusId) return [] as NodeRecord[];
    const ids = adjacency.neighbors.get(focusId) || new Set<string>();
    return renderGraph.nodes.filter((node) => ids.has(node.id)).slice(0, 12);
  }, [adjacency.neighbors, focusId, renderGraph.nodes]);
  const relatedNodeGroups = useMemo(() => {
    const labels: Record<Filter, string> = {
      all: 'All',
      substation: 'Substations',
      transformer: 'Transformers',
      feeder: 'Feeders',
      meter: 'Meters',
      other: 'Other',
    };
    const order: Filter[] = ['substation', 'transformer', 'feeder', 'meter', 'other'];
    return order
      .map((category) => ({
        category,
        label: labels[category],
        nodes: relatedNodes.filter((node) => node.category === category),
      }))
      .filter((group) => group.nodes.length > 0);
  }, [relatedNodes]);
  const selectedPolicySummary = useMemo(() => {
    if (!selectedNode) return null;
    const raw = selectedNode.properties.policy_summary;
    if (!raw || typeof raw !== 'object') return null;
    return raw as PolicySummaryRecord;
  }, [selectedNode]);
  const selectedPolicyActions = useMemo(() => {
    if (!selectedNode) return [] as string[];
    const raw = selectedNode.properties.policy_actions;
    return Array.isArray(raw) ? raw.map((value) => String(value)).filter(Boolean) : [];
  }, [selectedNode]);
  const selectedPolicyResources = useMemo(() => {
    if (!selectedNode) return [] as string[];
    const raw = selectedNode.properties.policy_resources;
    return Array.isArray(raw) ? raw.map((value) => String(value)).filter(Boolean) : [];
  }, [selectedNode]);
  const selectedDeniedActions = useMemo(() => {
    const raw = selectedPolicySummary?.deny_actions;
    return Array.isArray(raw) ? raw.map((value) => String(value)).filter(Boolean) : [];
  }, [selectedPolicySummary]);
  const selectedDeniedResources = useMemo(() => {
    const raw = selectedPolicySummary?.deny_resources;
    return Array.isArray(raw) ? raw.map((value) => String(value)).filter(Boolean) : [];
  }, [selectedPolicySummary]);
  useEffect(() => {
    let cancelled = false;
    const selectedName = selectedNode?.fullLabel || selectedNode?.label || '';

    if (!selectedNode?.id) {
      setPolicyDocument(null);
      setPolicyDocumentError(null);
      setPolicyDocumentLoading(false);
      return;
    }

    setPolicyDocumentLoading(true);
    setPolicyDocumentError(null);

    getCloudHoundPolicyDocument({
      selectedAwsAccountId: selectedAwsAccountId || 'giop',
      policyName: selectedName || selectedNode.id,
    })
      .then((doc) => {
        if (!cancelled) {
          setPolicyDocument(doc);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPolicyDocument(null);
        setPolicyDocumentError(err instanceof Error ? err.message : 'Failed to load policy document');
      })
      .finally(() => {
        if (!cancelled) {
          setPolicyDocumentLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAwsAccountId, selectedNode?.id, selectedNode?.category, selectedNode?.arn, selectedNode?.fullLabel, selectedNode?.label]);
  const selectedRelationshipCounts = useMemo(() => {
    return relatedNodeGroups.reduce<Record<Filter, number>>((acc, group) => {
      acc[group.category] = group.nodes.length;
      return acc;
    }, { all: 0, substation: 0, transformer: 0, feeder: 0, meter: 0, other: 0 });
  }, [relatedNodeGroups]);

  const quality = computeGraphQuality(renderGraph.nodes.length, isOpsChrome);
  const qualityConfig = GRAPH_QUALITY[quality];
  const selectedEdges = focusId ? (adjacency.nodeEdges.get(focusId)?.size || 0) : 0;
  const selectedEscalationDetails = useMemo(() => {
    if (!focusId) return [] as Array<{ id: string; type: string; explanation: string; sourceName: string; targetName: string }>;
    const connected = renderGraph.edges.filter(
      (edge) => edge.isPrivilegeEscalation && (edge.source === focusId || edge.target === focusId),
    );
    return connected.map((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return {
        id: edge.id,
        type: edge.escalationType || 'privilege_path',
        explanation: edge.chainExplanation || 'This edge participates in a privilege escalation path. Follow adjacent red edges to inspect the chain.',
        sourceName: source?.fullLabel || edge.source,
        targetName: target?.fullLabel || edge.target,
      };
    });
  }, [focusId, nodeById, renderGraph.edges]);

  const isAiQueryGraph = graph.query_key === 'ai_query';
  const aiQueryTitle = useMemo(() => {
    const metricTitle = graph.metrics && typeof graph.metrics.query_title === 'string'
      ? graph.metrics.query_title
      : '';
    return (graph.title || metricTitle || 'AI query').trim();
  }, [graph.metrics, graph.title]);
  const aiQueryNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!isAiQueryGraph) return ids;
    renderGraph.nodes.forEach((node) => ids.add(node.id));
    return ids;
  }, [isAiQueryGraph, renderGraph.nodes]);
  const aiQueryEdgeKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!isAiQueryGraph) return keys;
    renderGraph.edges.forEach((edge) => {
      keys.add(`${edge.source}|${edge.target}`);
      keys.add(`${edge.target}|${edge.source}`);
    });
    return keys;
  }, [isAiQueryGraph, renderGraph.edges]);

  useEffect(() => {
    if (!isAiQueryGraph || !renderGraph.nodes.length) {
      lastAiQueryFocusKeyRef.current = '';
      return;
    }

    const focusKey = `${aiQueryTitle}::${renderGraph.nodes.length}::${renderGraph.edges.length}`;
    if (lastAiQueryFocusKeyRef.current === focusKey) return;

    let attempts = 0;
    let cancelled = false;
    const tryFocus = () => {
      if (cancelled) return;
      attempts += 1;

      const candidateNodes = nodesRef.current.filter((node) => aiQueryNodeIds.has(node.id));
      if (candidateNodes.length > 0) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        candidateNodes.forEach((node) => {
          minX = Math.min(minX, node.x || 0);
          minY = Math.min(minY, node.y || 0);
          maxX = Math.max(maxX, node.x || 0);
          maxY = Math.max(maxY, node.y || 0);
        });

        const { width, height } = sizeRef.current;
        const spanX = Math.max(240, maxX - minX + 240);
        const spanY = Math.max(240, maxY - minY + 240);
        const zoom = clamp(Math.min(width / spanX, height / spanY) * 0.58, 0.3, 2.4);
        searchFocusUntilRef.current = 0;
        filterFocusUntilRef.current = 0;
        cameraTargetRef.current = {
          x: (minX + maxX) / 2,
          y: (minY + maxY) / 2,
          zoom,
        };
        if (candidateNodes.length === 1) {
          setActiveId(candidateNodes[0].id);
        }
        lastAiQueryFocusKeyRef.current = focusKey;
        return;
      }

      if (attempts < 8) {
        requestAnimationFrame(tryFocus);
      }
    };

    tryFocus();
    return () => {
      cancelled = true;
    };
  }, [aiQueryNodeIds, aiQueryTitle, isAiQueryGraph, renderGraph.edges.length, renderGraph.nodes.length]);

  const escalationTypeLabel = (type: string) => {
    if (type === 'direct_user_policy') return 'Direct user policy escalation';
    if (type === 'direct_role_policy') return 'Direct role policy escalation';
    if (type === 'group_membership') return 'Group membership chain';
    if (type === 'group_policy_inheritance') return 'Group policy inheritance';
    return 'Privilege escalation path';
  };

  const toggleFilter = (key: Filter) => {
    if (key === 'all') {
      setSelectedFilters(new Set<Filter>());
      return;
    }
    setSelectedFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isFilterActive = (key: Filter) => {
    if (key === 'all') return selectedFilters.size === 0;
    return selectedFilters.has(key);
  };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr };
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    const simNodes: SimNode[] = renderGraph.nodes.map((node) => ({
      ...node,
      x: (Math.random() - 0.5) * 30,
      y: (Math.random() - 0.5) * 30,
      vx: 0,
      vy: 0,
      drift: Math.random() * Math.PI * 2,
      driftSpeed: 0.12 + Math.random() * 0.12,
      driftRadius: 0.015 + Math.random() * 0.03,
    }));
    const nodeIdSet = new Set(renderGraph.nodes.map((node) => node.id));
    const simLinks: SimLink[] = renderGraph.edges
      .filter((edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target))
      .map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight, label: edge.label, confidence: edge.confidence, color: edge.color, isPrivilegeEscalation: edge.isPrivilegeEscalation }));

    nodesRef.current = simNodes;
    edgesRef.current = simLinks;
    resize();

    const simulation = forceSimulation(simNodes)
      .alpha(0.9)
      .alphaMin(0.001)
      .alphaDecay(0.05)
      .velocityDecay(0.48)
      .force('charge', forceManyBody<SimNode>().strength((node) => forceParamsRef.current.repel * Math.min(1.2, 240 / Math.max(90, simNodes.length)) * (1 + node.size * 0.02)).distanceMin(10).distanceMax(simNodes.length > 2400 ? 140 : 180).theta(0.86))
      .force('link', forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance((link) => forceParamsRef.current.linkDist + (2 - Math.min(2, link.weight)) * 6).strength((link) => forceParamsRef.current.linkStr + Math.min(0.18, link.weight * 0.08)))
      .force('collide', forceCollide<SimNode>((node) => node.size + 4).strength(0.82).iterations(2))
      .force('centerX', forceX(0).strength(centerForce * 0.35))
      .force('centerY', forceY(0).strength(centerForce * 0.35))
      .stop();
    simRef.current = simulation;

    const hitTest = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      let best: SimNode | null = null; let bestDistance = Infinity;
      for (let i = simNodes.length - 1; i >= 0; i -= 1) {
        const node = simNodes[i];
        const point = screen(node, cameraRef.current, sizeRef.current.width, sizeRef.current.height);
        const radius = (node.size + 6) * cameraRef.current.zoom;
        const dx = x - point.x; const dy = y - point.y; const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= radius && distance < bestDistance) { best = node; bestDistance = distance; }
      }
      return best;
    };

    const draw = () => {
      const width = sizeRef.current.width;
      const height = sizeRef.current.height;
      const camera = cameraRef.current;
      const ctx2d = ctx;
      const isLight = lightModeRef.current;
      const palette = {
        bgStart: isLight ? '#f1f5f9' : '#1a1a1a',
        bgEnd: isLight ? '#e0e7f1' : '#121212',
        edgeLabelBg: isLight ? 'rgba(241, 245, 249, 0.94)' : 'rgba(30, 30, 30, 0.94)',
        edgeLabelBgEsc: isLight ? 'rgba(254, 226, 226, 0.95)' : 'rgba(127, 29, 29, 0.94)',
        edgeLabelText: isLight ? '#475569' : '#a3a3a3',
        edgeLabelTextFocus: isLight ? '#1e293b' : '#d4d4d4',
        edgeLabelTextEsc: isLight ? '#7f1d1d' : '#fca5a5',
        nodeLabelBg: isLight ? 'rgba(241, 245, 249, 0.92)' : 'rgba(30, 30, 30, 0.88)',
        nodeLabelText: isLight ? '#1e293b' : '#bcbcbc',
        nodeLabelHoverText: isLight ? '#0f172a' : '#d0d0d0',
        nodeStrokeDefault: isLight ? 'rgba(100,116,139,0.4)' : 'rgba(11, 11, 11, 0.55)',
        hoverRing: isLight ? 'rgba(30, 41, 59, 0.25)' : 'rgba(212, 212, 212, 0.28)',
      };
      ctx2d.save();
      ctx2d.setTransform(sizeRef.current.dpr, 0, 0, sizeRef.current.dpr, 0, 0);
      ctx2d.clearRect(0, 0, width, height);
      const bg = ctx2d.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, Math.max(width, height) * 0.75);
      bg.addColorStop(0, palette.bgStart); bg.addColorStop(1, palette.bgEnd);
      ctx2d.fillStyle = bg; ctx2d.fillRect(0, 0, width, height);

      const zoom = camera.zoom;
      const edgeVisibilityBoost = edgeVisibilityRef.current;
      // Keep link labels visible significantly longer while zooming out.
      const linkLabelZoomThreshold = clamp(1.35 - (edgeVisibilityBoost - 0.5) * 0.8, 0.38, 1.35);
      const linkLabelBaseAlpha = clamp(0.56 + edgeVisibilityBoost * 0.2, 0.56, 0.96);
      const linkLabelFontScale = clamp(1.02 + edgeVisibilityBoost * 0.24, 1.02, 1.45);
      const labelZoom = textFadeZoomRef.current;
      // Only hide labels when extremely zoomed out
      const drawAll = zoom >= Math.max(0.2, labelZoom);
      const query = searchRef.current.trim();
      const searchHits = query ? renderGraph.nodes.filter((node) => matchesSearchQuery([node.label, node.fullLabel, node.nodeType, node.arn, node.category, ...node.tags], query)) : [];

      const visibleNodes = new Set<string>();
      // Apply search as a real filter so matching nodes are immediately obvious.
      if (query) {
        searchHits.forEach((node) => visibleNodes.add(node.id));
        if (activeRef.current) visibleNodes.add(activeRef.current);
        if (hoverStateRef.current) visibleNodes.add(hoverStateRef.current);
      } else {
        // Keep all nodes visible by default when no search query is present.
        if (filterRef.current.size === 0) {
          renderGraph.nodes.forEach((node) => visibleNodes.add(node.id));
        } else {
          renderGraph.nodes.forEach((node) => {
            if (filterRef.current.has(node.category)) visibleNodes.add(node.id);
          });
        }
        if (activeRef.current) visibleNodes.add(activeRef.current);
        if (hoverStateRef.current) visibleNodes.add(hoverStateRef.current);
      }

      // Add path nodes to visible set if path is found
      const pathNodeIds = new Set<string>();
      const pathEdgeKeys = new Set<string>();
      if (foundPath && foundPath.found && foundPath.path.nodes.length > 0) {
        foundPath.path.nodes.forEach((node) => {
          visibleNodes.add(node.id);
          pathNodeIds.add(node.id);
        });
        foundPath.path.edges.forEach((edge) => {
          // Create a key from source and target for edge identification
          pathEdgeKeys.add(`${edge.source}|${edge.target}`);
        });
      }

      const focusNeighborhood = new Set<string>();
      const focusSeed = activeRef.current || hoverStateRef.current || null;
      if (focusSeed) {
        const queue: Array<{ id: string; depth: number }> = [{ id: focusSeed, depth: 0 }];
        while (queue.length) {
          const current = queue.shift();
          if (!current || focusNeighborhood.has(current.id)) continue;
          focusNeighborhood.add(current.id);
          if (current.depth >= depthRef.current) continue;
          (adjacency.neighbors.get(current.id) || new Set<string>()).forEach((neighbor) => queue.push({ id: neighbor, depth: current.depth + 1 }));
        }
      }

      // After d3-force runs, edge.source/target are mutated to SimNode objects — resolve id from either form
      const edgeSourceId = (e: SimLink) => typeof e.source === 'object' && e.source !== null ? (e.source as SimNode).id : e.source as string;
      const edgeTargetId = (e: SimLink) => typeof e.target === 'object' && e.target !== null ? (e.target as SimNode).id : e.target as string;
      const nodeBySimId = new Map<string, SimNode>();
      nodesRef.current.forEach((node) => nodeBySimId.set(node.id, node));
      const edgeCandidates = edgesRef.current.filter((edge) => visibleNodes.has(edgeSourceId(edge)) && visibleNodes.has(edgeTargetId(edge)));
      const cap = qualityConfig.edgeCap;
      const priority = new Set<string>([activeRef.current, hoverStateRef.current, ...searchHits.slice(0, 6).map((n) => n.id)].filter(Boolean) as string[]);
      const visibleEdges = edgeCandidates.length <= cap ? edgeCandidates : edgeCandidates.map((edge) => {
        const isPrivEsc = edge.isPrivilegeEscalation;
        const score = edge.weight * 8 + edge.confidence * 5 + ((priority.has(edgeSourceId(edge)) || priority.has(edgeTargetId(edge))) ? 40 : 0) + (isPrivEsc ? 100 : 0);
        return { edge, score };
      }).sort((a, b) => b.score - a.score).slice(0, cap).map((entry) => entry.edge);

      visibleEdges.forEach((edge) => {
        const source = typeof edge.source === 'object' && edge.source !== null ? edge.source as SimNode : nodeBySimId.get(edge.source as string);
        const target = typeof edge.target === 'object' && edge.target !== null ? edge.target as SimNode : nodeBySimId.get(edge.target as string);
        if (!source || !target) return;
        const s = screen(source, camera, width, height);
        const t = screen(target, camera, width, height);
        if (qualityConfig.viewportCull && !isOnScreen(s.x, s.y, width, height) && !isOnScreen(t.x, t.y, width, height)) {
          return;
        }
        const srcId = (source as SimNode).id;
        const tgtId = (target as SimNode).id;
        const connectedFocus = activeRef.current ? srcId === activeRef.current || tgtId === activeRef.current : false;
        const connectedHover = hoverStateRef.current ? srcId === hoverStateRef.current || tgtId === hoverStateRef.current : false;
        const isPrivEsc = edge.isPrivilegeEscalation;
        const isPathEdge = pathEdgeKeys.has(`${srcId}|${tgtId}`) || pathEdgeKeys.has(`${tgtId}|${srcId}`);
        const isAiQueryEdge = isAiQueryGraph && aiQueryEdgeKeys.has(`${srcId}|${tgtId}`);
        
        ctx2d.save();
        // Privilege escalation edges are always highly visible
        // Path edges should be highly visible when path is found
        const baseEdgeAlpha = Math.min(1, 0.72 + edgeVisibilityBoost * 0.24);
        const lowZoomAlphaBoost = zoom < 0.9 ? (0.9 - zoom) * 0.2 : 0;
        ctx2d.globalAlpha = isPathEdge
          ? 0.98
          : isAiQueryEdge
            ? 0.9
          : connectedHover
            ? 1
            : connectedFocus
              ? 1
              : isPrivEsc
                ? 0.96
                : activeRef.current
                  ? Math.min(1, baseEdgeAlpha + 0.06 + lowZoomAlphaBoost)
                  : Math.min(1, baseEdgeAlpha + lowZoomAlphaBoost);
        
        if (isPathEdge) {
          ctx2d.strokeStyle = 'rgba(255, 215, 0, 0.9)'; // Bright gold for path
        } else if (isAiQueryEdge) {
          ctx2d.strokeStyle = connectedHover || connectedFocus
            ? 'rgba(125, 211, 252, 0.98)'
            : 'rgba(56, 189, 248, 0.82)';
        } else if (connectedHover) {
          ctx2d.strokeStyle = vibrantEdgeColor(edge.color);
        } else if (connectedFocus) {
          // Match hover vibrance while preserving relationship hue.
          ctx2d.strokeStyle = vibrantEdgeColor(edge.color);
        } else if (isPrivEsc) {
          // Keep privilege escalation edges bright red
          ctx2d.strokeStyle = 'rgba(239, 68, 68, 0.95)';
        } else {
          ctx2d.strokeStyle = edge.color;
        }
        
        const baseThickness = edge.weight * 1.1 * linkThicknessRef.current;
        const lowZoomWidthBoost = zoom < 1 ? 1 + (1 - zoom) * 0.9 : 1;
        const minRegularEdgeWidth = 0.55 + edgeVisibilityBoost * 0.6;
        ctx2d.lineWidth = isPathEdge
          ? 3.2
          : isAiQueryEdge
            ? Math.max(1.8, baseThickness * 1.2)
          : connectedHover
            ? 2.8
            : connectedFocus
              ? 2.4
              : isPrivEsc
                ? Math.max(0.7, baseThickness)
                : Math.max(minRegularEdgeWidth, baseThickness * Math.max(0.85, zoom * 0.78) * lowZoomWidthBoost);
        
        // Enhanced shadow for privilege escalation and path edges (skipped at balanced/safe tiers)
        if (qualityConfig.shadows) {
          if (isPathEdge) {
            ctx2d.shadowColor = 'rgba(255, 215, 0, 0.4)';
            ctx2d.shadowBlur = 16;
          } else if (isAiQueryEdge) {
            ctx2d.shadowColor = connectedHover || connectedFocus
              ? 'rgba(125, 211, 252, 0.72)'
              : 'rgba(56, 189, 248, 0.34)';
            ctx2d.shadowBlur = connectedHover || connectedFocus ? 16 : 10;
          } else if (isPrivEsc) {
            ctx2d.shadowColor = (connectedHover || connectedFocus) ? vibrantEdgeColor(edge.color) : 'rgba(239, 68, 68, 0.35)';
            ctx2d.shadowBlur = (connectedHover || connectedFocus) ? 16 : 12;
          } else {
            ctx2d.shadowColor = (connectedHover || connectedFocus) ? vibrantEdgeColor(edge.color) : 'rgba(120, 150, 200, 0.18)';
            ctx2d.shadowBlur = (connectedHover || connectedFocus) ? 14 : 6;
          }
        }
        
        let lineEndX = t.x;
        let lineEndY = t.y;
        let arrowTipX = t.x;
        let arrowTipY = t.y;
        let arrowAngle = Math.atan2(t.y - s.y, t.x - s.x);
        let arrowLength = clamp(6.2 + zoom * 1.25, 5.5, 12.5);
        let arrowHalfWidth = clamp(2.8 + zoom * 0.55, 2.6, 6.2);

        if (showArrowsRef.current) {
          const angle = Math.atan2(t.y - s.y, t.x - s.x);
          const targetFocused = activeRef.current === tgtId;
          const targetHovered = hoverStateRef.current === tgtId;
          const targetRadius = Math.max(
            4,
            target.size * nodeSizeMultRef.current * (targetFocused ? 1.5 : targetHovered ? 1.25 : 1),
          );
          const arrowTipOffset = targetRadius + Math.max(3, 2.5 * zoom);
          const tipX = t.x - Math.cos(angle) * arrowTipOffset;
          const tipY = t.y - Math.sin(angle) * arrowTipOffset;
          lineEndX = tipX;
          lineEndY = tipY;
          arrowTipX = tipX;
          arrowTipY = tipY;
          arrowAngle = angle;
          arrowLength = clamp(6.2 + zoom * 1.25, 5.5, 12.5);
          arrowHalfWidth = clamp(2.8 + zoom * 0.55, 2.6, 6.2);
        }

        ctx2d.beginPath();
        ctx2d.moveTo(s.x, s.y);
        ctx2d.lineTo(lineEndX, lineEndY);
        ctx2d.stroke();
        ctx2d.shadowBlur = 0;
        
        if (showArrowsRef.current) {
          ctx2d.save();
          ctx2d.translate(arrowTipX, arrowTipY);
          ctx2d.rotate(arrowAngle);
          ctx2d.fillStyle = ctx2d.strokeStyle as string;
          ctx2d.globalAlpha = Math.min(1, (ctx2d.globalAlpha || 1) + 0.05);
          ctx2d.beginPath();
          ctx2d.moveTo(0, 0);
          ctx2d.lineTo(-arrowLength, arrowHalfWidth);
          ctx2d.lineTo(-arrowLength * 0.62, 0);
          ctx2d.lineTo(-arrowLength, -arrowHalfWidth);
          ctx2d.closePath();
          ctx2d.fill();
          ctx2d.restore();
        }
        // Show edge label on focused connection or when zoomed in
        const showLabel = connectedFocus || isPrivEsc || zoom >= linkLabelZoomThreshold;
        if (showLabel) {
          const labelAlpha = connectedFocus || isPrivEsc
            ? Math.min(1, linkLabelBaseAlpha + 0.2)
            : Math.min(1, linkLabelBaseAlpha + (zoom < 0.85 ? (0.85 - zoom) * 0.22 : 0));
          ctx2d.font = `${Math.max(10, 10 * zoom * linkLabelFontScale)}px Inter, ui-sans-serif, system-ui`;
          const edgeWidth = ctx2d.measureText(edge.label).width + 12;
          roundRect(ctx2d, (s.x + t.x) / 2 - edgeWidth / 2, (s.y + t.y) / 2 - 18, edgeWidth, 20, 7, isPrivEsc ? palette.edgeLabelBgEsc : palette.edgeLabelBg, labelAlpha);
          ctx2d.globalAlpha = labelAlpha; 
          ctx2d.fillStyle = connectedFocus ? palette.edgeLabelTextFocus : isPrivEsc ? palette.edgeLabelTextEsc : palette.edgeLabelText; 
          ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle'; ctx2d.fillText(edge.label, (s.x + t.x) / 2, (s.y + t.y) / 2 - 8);
        }
        ctx2d.restore();
      });

      nodesRef.current.forEach((node) => {
        if (!visibleNodes.has(node.id)) return;
        const p = screen(node, camera, width, height);
        const focused = activeRef.current === node.id;
        const hovered = hoverStateRef.current === node.id;
        const searchHit = searchHits.some((hit) => hit.id === node.id);
        const inFocusNeighborhood = !activeRef.current || focusNeighborhood.has(node.id);
        const isPathNode = pathNodeIds.has(node.id);
        const isAiQueryNode = isAiQueryGraph && aiQueryNodeIds.has(node.id);
        const currentAiAssist = aiAssistRef.current;
        const isAiAssistNode = currentAiAssist?.isOpen && currentAiAssist.nodeId === node.id;
        const nodeValidation =
          typeof node.properties?.validation === 'string' ? node.properties.validation : undefined;
        const isStagingNode =
          nodeValidation === 'PENDING_FIELD' || nodeValidation === 'STAGED';
        const stagingPulseColor = nodeValidation === 'STAGED' ? '#3b82f6' : '#f59e0b';
        const isPriorityNode = focused || hovered || searchHit || isPathNode || isAiQueryNode || isAiAssistNode || isStagingNode;
        if (qualityConfig.viewportCull && !isPriorityNode && !isOnScreen(p.x, p.y, width, height)) {
          return;
        }
        const dimmed = !!activeRef.current && !focused && !hovered && !inFocusNeighborhood && !isPathNode;
        const shouldPulse = qualityConfig.pulseRipples && (isAiAssistNode || isStagingNode);
        const pulseStrength = shouldPulse ? (Math.sin(animationTimeRef.current * 4.6) + 1) * 0.5 : 0;
        const pulseScale = shouldPulse
          ? 1 + pulseStrength * (isStagingNode && !isAiAssistNode ? 0.012 : 0.018)
          : 1;
        const ripplePhase = shouldPulse ? (animationTimeRef.current * 0.72) % 1 : 0;
        const ripplePhaseSecondary = shouldPulse ? (ripplePhase + 0.5) % 1 : 0;
        const heatColor = heatMapEnabledRef.current ? node.riskColor : null;
        const nodeDisplayColor = isAiAssistNode ? node.color : focused ? '#f8fafc' : searchHit ? '#f4d06f' : heatColor ?? node.color;
        const radius = Math.max(4, node.size * nodeSizeMultRef.current * (focused ? 1.5 : hovered ? 1.25 : isPathNode ? 1.3 : 1) * pulseScale);
        const labelVisible = hovered || searchHit || isPathNode || isAiQueryNode || (drawAll && zoom >= qualityConfig.labelZoom);
        const label = labelVisible ? node.fullLabel : node.label;
        ctx2d.save();
        ctx2d.globalAlpha = dimmed ? 0.35 : 1;
        if (qualityConfig.shadows && (focused || hovered || heatColor || node.isHvt || node.trustExternal || node.dangerousPolicy || isPathNode || isAiAssistNode || isAiQueryNode || isStagingNode)) {
          ctx2d.shadowColor = isAiAssistNode
            ? node.color
            : isStagingNode
            ? stagingPulseColor
            : isPathNode
            ? 'rgba(255,215,0,0.4)'
            : isAiQueryNode
            ? 'rgba(56, 189, 248, 0.24)'
            : heatColor
            ? heatColor
            : node.dangerousPolicy
            ? 'rgba(239,68,68,0.35)'
            : node.isHvt
              ? 'rgba(244,208,111,0.32)'
              : node.trustExternal
                ? 'rgba(255,145,90,0.3)'
                : focused
                  ? 'rgba(248,250,252,0.35)'
                  : 'rgba(159,174,255,0.25)';
          ctx2d.shadowBlur = isAiAssistNode
            ? 9 + pulseStrength * 4
            : isStagingNode
            ? 8 + pulseStrength * 5
            : isAiQueryNode
            ? 10
            : heatColor
            ? 16
            : node.dangerousPolicy
            ? 16
            : node.isHvt || node.trustExternal
            ? 12
            : 14;
        }
        ctx2d.fillStyle = nodeDisplayColor;
        ctx2d.beginPath(); ctx2d.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx2d.fill();
        ctx2d.shadowBlur = 0;

        if (isAiAssistNode) {
          const drawRipple = (phase: number, baseWidth: number) => {
            ctx2d.save();
            ctx2d.globalAlpha = Math.max(0, 0.2 * (1 - phase));
            ctx2d.strokeStyle = node.color;
            ctx2d.lineWidth = baseWidth + (1 - phase) * 0.35;
            ctx2d.beginPath();
            ctx2d.arc(p.x, p.y, radius + 3 + phase * 12, 0, Math.PI * 2);
            ctx2d.stroke();
            ctx2d.restore();
          };

          drawRipple(ripplePhase, 1.2);
          drawRipple(ripplePhaseSecondary, 0.9);
        }

        if (isStagingNode && !isAiAssistNode) {
          const drawStagingRipple = (phase: number, baseWidth: number) => {
            ctx2d.save();
            ctx2d.globalAlpha = Math.max(0, 0.22 * (1 - phase));
            ctx2d.strokeStyle = stagingPulseColor;
            ctx2d.lineWidth = baseWidth + (1 - phase) * 0.4;
            ctx2d.beginPath();
            ctx2d.arc(p.x, p.y, radius + 2.5 + phase * 9, 0, Math.PI * 2);
            ctx2d.stroke();
            ctx2d.restore();
          };

          drawStagingRipple(ripplePhase, 1.15);
          drawStagingRipple(ripplePhaseSecondary, 0.9);
        }

        if (heatColor) {
          const heatSeed = (node.id.length % 11) / 11;
          const heatPhase = (animationTimeRef.current * 0.62 + heatSeed) % 1;
          const heatPhaseSecondary = (heatPhase + 0.5) % 1;
          const drawHeatRipple = (phase: number, alpha: number, width: number) => {
            ctx2d.save();
            ctx2d.globalAlpha = Math.max(0, alpha * (1 - phase));
            ctx2d.strokeStyle = heatColor;
            ctx2d.lineWidth = width;
            ctx2d.beginPath();
            ctx2d.arc(p.x, p.y, radius + 5 + phase * 18, 0, Math.PI * 2);
            ctx2d.stroke();
            ctx2d.restore();
          };

          drawHeatRipple(heatPhase, 0.24, 1.25);
          drawHeatRipple(heatPhaseSecondary, 0.14, 0.9);
        }
        
        // Path node styling
        if (isPathNode) {
          ctx2d.strokeStyle = 'rgba(255, 215, 0, 0.95)';
          ctx2d.lineWidth = 2.8;
          ctx2d.stroke();
          // Add outer glow for path nodes
          ctx2d.strokeStyle = 'rgba(255, 215, 0, 0.4)';
          ctx2d.lineWidth = 1.2;
          ctx2d.beginPath(); ctx2d.arc(p.x, p.y, radius + 3, 0, Math.PI * 2); ctx2d.stroke();
        } else if (isAiQueryNode) {
          ctx2d.strokeStyle = focused ? '#f8fafc' : 'rgba(125, 211, 252, 0.95)';
          ctx2d.lineWidth = focused ? 2.2 : 1.8;
          ctx2d.stroke();
          ctx2d.strokeStyle = 'rgba(56, 189, 248, 0.22)';
          ctx2d.lineWidth = 1;
          ctx2d.beginPath(); ctx2d.arc(p.x, p.y, radius + 3, 0, Math.PI * 2); ctx2d.stroke();
        } else {
          ctx2d.strokeStyle = isAiAssistNode
            ? node.color
            : heatColor
            ? heatColor
            : node.dangerousPolicy
            ? 'rgba(248,113,113,0.95)'
            : node.isHvt
              ? 'rgba(244,208,111,0.98)'
              : node.trustExternal
                ? 'rgba(255,145,90,0.95)'
                : focused
                  ? '#f8fafc'
                  : palette.nodeStrokeDefault;
          ctx2d.lineWidth = heatColor ? 2.4 : node.dangerousPolicy || node.isHvt || node.trustExternal ? 2.2 : focused ? 2 : 1;
          ctx2d.stroke();
        }
        if (node.category === 'meter') {
          drawUserGlyph(ctx2d, p.x, p.y, radius, focused || hovered || searchHit);
        }
        if (heatColor || node.isHvt || node.trustExternal || node.dangerousPolicy) {
          ctx2d.beginPath();
          ctx2d.arc(p.x, p.y, radius + 4.5, 0, Math.PI * 2);
          ctx2d.strokeStyle = heatColor
            ? heatColor
            : node.dangerousPolicy
            ? 'rgba(239,68,68,0.72)'
            : node.isHvt
              ? 'rgba(244,208,111,0.82)'
              : 'rgba(255,145,90,0.72)';
          ctx2d.lineWidth = heatColor ? 2.1 : node.dangerousPolicy ? 2 : 1.6;
          ctx2d.stroke();
        }
        if (labelVisible) {
          ctx2d.font = `${Math.max(10, 11 * zoom)}px Inter, ui-sans-serif, system-ui`;
          const textWidth = ctx2d.measureText(label).width + 10;
          roundRect(ctx2d, p.x - textWidth / 2, p.y - radius - 16, textWidth, 20, 7, palette.nodeLabelBg, dimmed ? 0.35 : drawAll ? 0.96 : 0.82);
          ctx2d.globalAlpha = dimmed ? 0.35 : drawAll ? 0.96 : 0.82;
          ctx2d.fillStyle = hovered ? palette.nodeLabelHoverText : palette.nodeLabelText; ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle'; ctx2d.fillText(label, p.x, p.y - radius - 6);
        }
        ctx2d.restore();
      });

      const hovered = nodesRef.current.find((node) => node.id === hoverStateRef.current);
      if (hovered) {
        const p = screen(hovered, camera, width, height);
        ctx2d.save(); ctx2d.strokeStyle = palette.hoverRing; ctx2d.lineWidth = 1.5; ctx2d.beginPath(); ctx2d.arc(p.x, p.y, Math.max(7, hovered.size * 1.8), 0, Math.PI * 2); ctx2d.stroke(); ctx2d.restore();
      }

      ctx2d.restore();
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      // Close context menu on any canvas interaction
      if (contextMenu.visible) {
        setContextMenu({ visible: false, x: 0, y: 0, node: null });
      }
      if (emptySpaceMenu.visible) {
        setEmptySpaceMenu({ visible: false, x: 0, y: 0 });
      }
      
      canvas.setPointerCapture(event.pointerId);
      startRef.current = { x: event.clientX, y: event.clientY };
      pointerMovedRef.current = false;
      const node = hitTest(event.clientX, event.clientY);
      if (node) {
        // Path finding mode: select nodes instead of normal interaction
        if (pathFindingEnabledRef.current) {
          const nodeRecord = renderGraph.nodes.find((n) => n.id === node.id);
          if (nodeRecord) {
            handlePathFindingNodeClick(nodeRecord);
          }
          return;
        }

        modeRef.current = 'node';
        dragRef.current = node.id;
        const target = simNodes.find((item) => item.id === node.id);
        if (target) { target.fx = target.x; target.fy = target.y; }
        setActiveId(node.id);
        const nodeRecord = renderGraph.nodes.find((n) => n.id === node.id);
        onNodeSelectRef.current?.(node.id, nodeRecord?.fullLabel || nodeRecord?.label);
        simulation.alphaTarget(0.12).restart();
      } else {
        modeRef.current = 'pan';
      }
      searchFocusUntilRef.current = 0;
      filterFocusUntilRef.current = 0;
      setAnimating(true);
      scheduleFrame();
    };

    const onMove = (event: PointerEvent) => {
      scheduleFrame();
      const distance = Math.hypot(event.clientX - startRef.current.x, event.clientY - startRef.current.y);
      if (distance > 4) {
        pointerMovedRef.current = true;
      }

      if (contextMenu.visible && contextMenu.node) {
        const nodeAtPointer = hitTest(event.clientX, event.clientY);
        if (!nodeAtPointer || nodeAtPointer.id !== contextMenu.node.id) {
          setContextMenu({ visible: false, x: 0, y: 0, node: null });
        }
      }

      if (modeRef.current === 'node' && dragRef.current) {
        const dragged = simNodes.find((item) => item.id === dragRef.current);
        if (dragged) {
          const next = graphPoint(event.clientX - canvas.getBoundingClientRect().left, event.clientY - canvas.getBoundingClientRect().top, cameraRef.current, sizeRef.current.width, sizeRef.current.height);
          dragged.fx = next.x; dragged.fy = next.y; dragged.vx = 0; dragged.vy = 0;
        }
        return;
      }
      if (modeRef.current === 'pan') {
        const dx = (event.clientX - startRef.current.x) / cameraRef.current.zoom;
        const dy = (event.clientY - startRef.current.y) / cameraRef.current.zoom;
        cameraTargetRef.current.x -= dx; cameraTargetRef.current.y -= dy; startRef.current = { x: event.clientX, y: event.clientY };
        return;
      }
      const node = hitTest(event.clientX, event.clientY);
      if (node && node.id !== hoverRef.current) { hoverRef.current = node.id; setHoverId(node.id); } else if (!node && hoverRef.current) { hoverRef.current = null; setHoverId(null); }
    };

    const onUp = (event: PointerEvent) => {
      try { canvas.releasePointerCapture(event.pointerId); } catch { /* noop */ }
      if (modeRef.current === 'node' && dragRef.current) {
        const dragged = simNodes.find((item) => item.id === dragRef.current);
        if (dragged) { dragged.fx = null; dragged.fy = null; dragged.vx = (dragged.vx || 0) * 0.4; dragged.vy = (dragged.vy || 0) * 0.4; }
        simulation.alphaTarget(0.04);
      }
      modeRef.current = 'none';
      dragRef.current = null;
      writeCameraPrefs(cameraTargetRef.current);
      setAnimating(simulation.alpha() > 0.02);
      scheduleFrame();
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      scheduleFrame();
      searchFocusUntilRef.current = 0;
      filterFocusUntilRef.current = 0;
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left; const sy = event.clientY - rect.top;
      const current = cameraTargetRef.current;
      const before = graphPoint(sx, sy, current, sizeRef.current.width, sizeRef.current.height);
      const nextZoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0012), CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM);
      const after = { x: (sx - sizeRef.current.width / 2) / nextZoom + current.x, y: (sy - sizeRef.current.height / 2) / nextZoom + current.y };
      cameraTargetRef.current = { x: current.x + (before.x - after.x), y: current.y + (before.y - after.y), zoom: nextZoom };
      writeCameraPrefs(cameraTargetRef.current);
    };

    const fitView = (animate = true) => {
      if (!nodesRef.current.length) return;
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      nodesRef.current.forEach((node) => { minX = Math.min(minX, node.x || 0); minY = Math.min(minY, node.y || 0); maxX = Math.max(maxX, node.x || 0); maxY = Math.max(maxY, node.y || 0); });
      const width = sizeRef.current.width; const height = sizeRef.current.height;
      const zoom = clamp(Math.min(width / Math.max(1, maxX - minX), height / Math.max(1, maxY - minY)) * 0.72, 0.3, 3.2);
      const next = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
      if (animate) cameraTargetRef.current = next; else { cameraRef.current = next; cameraTargetRef.current = next; }
    };

    const onDblClick = () => fitView(true);
    
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (pathFindingEnabledRef.current) return;
      
      const rect = canvas.getBoundingClientRect();
      const node = hitTest(event.clientX, event.clientY);
      if (node) {
        if (!isAdmin) return;
        setEmptySpaceMenu({ visible: false, x: 0, y: 0 });
        setContextMenu({
          visible: true,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          node,
        });
        return;
      }

      setContextMenu({ visible: false, x: 0, y: 0, node: null });
      setEmptySpaceMenu({
        visible: true,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.style.cursor = 'default';

    resizeRef.current?.disconnect();
    resizeRef.current = new ResizeObserver(() => { resize(); draw(); scheduleFrame(); });
    resizeRef.current.observe(container);
    const restoredCamera = readCameraPrefs();
    if (restoredCamera) {
      cameraRef.current = restoredCamera;
      cameraTargetRef.current = restoredCamera;
    }

    // If a filter is selected (and no search), fit camera to filtered nodes.
    // Skip this when restoring a saved camera so refresh keeps the user's last view.
    requestAnimationFrame(() => {
      if (restoredCamera) return;
      const query = searchRef.current.trim();
      if (!query && filterRef.current.size > 0 && nodesRef.current.length > 0) {
        // Only show filtered nodes
        const filtered = nodesRef.current.filter((node) => filterRef.current.has(node.category));
        if (filtered.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          filtered.forEach((node) => {
            minX = Math.min(minX, node.x || 0);
            minY = Math.min(minY, node.y || 0);
            maxX = Math.max(maxX, node.x || 0);
            maxY = Math.max(maxY, node.y || 0);
          });
          const width = sizeRef.current.width;
          const height = sizeRef.current.height;
          const spanX = Math.max(220, maxX - minX + 220);
          const spanY = Math.max(220, maxY - minY + 220);
          const fitZoom = clamp(Math.min(width / spanX, height / spanY) * 0.72, 0.3, 3.2);
          const next = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom: fitZoom };
          cameraRef.current = next;
          cameraTargetRef.current = next;
        }
      } else {
        fitView(true);
      }
    });


    const hasStagingNodes = simNodes.some((node) => {
      const v = node.properties?.validation;
      return v === 'PENDING_FIELD' || v === 'STAGED';
    });

    const scheduleFrame = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(tick);
    };

    const tick = (timestamp: number) => {
      rafRef.current = null;
      const activeQuery = searchRef.current.trim();
      if (
        !activeQuery &&
        filterRef.current.size > 0 &&
        filterFocusUntilRef.current > timestamp &&
        !dragRef.current &&
        modeRef.current !== 'pan'
      ) {
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        let matchCount = 0;
        simNodes.forEach((node) => {
          if (!filterRef.current.has(node.category)) return;
          matchCount += 1;
          minX = Math.min(minX, node.x || 0);
          minY = Math.min(minY, node.y || 0);
          maxX = Math.max(maxX, node.x || 0);
          maxY = Math.max(maxY, node.y || 0);
        });

        if (matchCount > 0) {
          const { width, height } = sizeRef.current;
          const spanX = Math.max(320, maxX - minX + 320);
          const spanY = Math.max(320, maxY - minY + 320);
          // Intentionally looser framing so users see most filtered nodes.
          const fitZoom = clamp(Math.min(width / spanX, height / spanY) * 0.56, 0.08, 0.88);
          cameraTargetRef.current = {
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            zoom: fitZoom,
          };
        }
      }

      // While searching, glide the camera so the best live match is centered
      // and zoomed in. Following a single node (rather than fitting the whole
      // match set) keeps the focus stable as the query is refined, instead of
      // zooming out to the whole graph on broad partial queries.
      if (
        activeQuery &&
        searchFocusUntilRef.current > timestamp &&
        !dragRef.current &&
        modeRef.current !== 'pan'
      ) {
        const bestId = searchBestIdRef.current;
        const best = bestId ? simNodes.find((node) => node.id === bestId) : null;
        if (best) {
          cameraTargetRef.current = {
            x: best.x || 0,
            y: best.y || 0,
            zoom: Math.max(cameraTargetRef.current.zoom, 1.6),
          };
        }
      }

      cameraRef.current.x = lerp(cameraRef.current.x, cameraTargetRef.current.x, 0.08);
      cameraRef.current.y = lerp(cameraRef.current.y, cameraTargetRef.current.y, 0.08);
      cameraRef.current.zoom = lerp(cameraRef.current.zoom, cameraTargetRef.current.zoom, 0.1);

      updateAiAssistAnchor();

      if (timestamp - lastCameraPersistAtRef.current > 350) {
        writeCameraPrefs(cameraRef.current);
        lastCameraPersistAtRef.current = timestamp;
      }

      const last = (tick as unknown as { last?: number }).last ?? timestamp;
      const elapsed = Math.max(8, timestamp - last);
      (tick as unknown as { last?: number }).last = timestamp;
      animationTimeRef.current = timestamp * 0.001;
      const dt = Math.min(2.2, elapsed / 16.67);
      const count = Math.max(1, Math.round(qualityConfig.simTicks * dt));
      for (let i = 0; i < count; i += 1) {
        const alpha = simulation.alpha();
        const time = timestamp * 0.001;
        if (qualityConfig.drift) {
          simNodes.forEach((node) => {
            const currentAiAssist = aiAssistRef.current;
            const isAiAssistNode = currentAiAssist?.isOpen && currentAiAssist.nodeId === node.id;
            const nodeValidation =
              typeof node.properties?.validation === 'string' ? node.properties.validation : undefined;
            const isStagingNode =
              nodeValidation === 'PENDING_FIELD' || nodeValidation === 'STAGED';
            const isFocusedNode = activeRef.current === node.id;
            const driftMultiplier = isAiAssistNode ? 0.22 : isStagingNode ? 0.45 : isFocusedNode ? 0.55 : 1;
            const sway = node.driftRadius * (0.08 + alpha * 0.18) * dt * driftMultiplier;
            node.vx = (node.vx || 0) + Math.cos(time * node.driftSpeed + node.drift) * sway;
            node.vy = (node.vy || 0) + Math.sin(time * node.driftSpeed * 0.87 + node.drift * 1.1) * sway;
          });
        }
        simulation.tick();
      }
      if (!dragRef.current) {
        if (simNodes.length > 800) {
          simulation.alphaTarget(simulation.alpha() < 0.025 ? 0 : 0.015);
        } else {
          simulation.alphaTarget(simulation.alpha() < 0.03 ? 0.018 : 0.03);
        }
      }
      draw();

      const allowIdlePause = quality !== 'ultra' || simNodes.length > 400;
      const cameraMoving =
        Math.abs(cameraRef.current.x - cameraTargetRef.current.x) > 0.08
        || Math.abs(cameraRef.current.y - cameraTargetRef.current.y) > 0.08
        || Math.abs(cameraRef.current.zoom - cameraTargetRef.current.zoom) > 0.004;
      const simActive = simulation.alpha() > 0.02;
      const interacting = dragRef.current !== null || modeRef.current === 'pan';
      const needsPulse = qualityConfig.pulseRipples && (hasStagingNodes || Boolean(aiAssistRef.current?.isOpen));
      const keepAnimating = simActive || cameraMoving || interacting || needsPulse || !allowIdlePause;
      setAnimating(keepAnimating);
      if (!keepAnimating && allowIdlePause) {
        simulation.alphaTarget(0);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    scheduleFrame();

    return () => {
      writeCameraPrefs(cameraRef.current);
      simulation.stop();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      resizeRef.current?.disconnect();
      setAnimating(false);
    };
  }, [adjacency.neighbors, isOpsChrome, quality, renderGraph]);

  const commitSearch = () => {
    const next = searchInput.trim();
    setSearch(next);
    lastAutoFocusKeyRef.current = '';
    setSearchCommitTick((tick) => tick + 1);
  };

  const resetView = () => {
    setSearch(''); setSearchInput(''); setActiveId(null); setHoverId(null); setSelectedFilters(new Set<Filter>()); setDepth(2); cameraRef.current = { x: 0, y: 0, zoom: 1 }; cameraTargetRef.current = { x: 0, y: 0, zoom: 1 };
  };

  const reframe = () => {
    if (!nodesRef.current.length) return;
    const query = search.trim();
    const idSet = new Set<string>();

    if (query) {
      committedSearchMatches.forEach((node) => idSet.add(node.id));
    } else if (selectedFilters.size > 0) {
      renderGraph.nodes.forEach((node) => {
        if (selectedFilters.has(node.category)) idSet.add(node.id);
      });
    }

    const candidateNodes = idSet.size
      ? nodesRef.current.filter((node) => idSet.has(node.id))
      : nodesRef.current;
    if (!candidateNodes.length) return;

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    candidateNodes.forEach((node) => {
      minX = Math.min(minX, node.x || 0);
      minY = Math.min(minY, node.y || 0);
      maxX = Math.max(maxX, node.x || 0);
      maxY = Math.max(maxY, node.y || 0);
    });
    const { width, height } = sizeRef.current;
    const spanX = Math.max(220, maxX - minX + 220);
    const spanY = Math.max(220, maxY - minY + 220);
    const zoom = clamp(Math.min(width / spanX, height / spanY) * 0.62, 0.28, 3.2);
    cameraTargetRef.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
  };

  const modeLabel = quality === 'safe' ? 'dense' : quality === 'balanced' ? 'balanced' : 'ultra';

  const focusNodeInFrame = (nodeId: string, panelOpen: boolean) => {
    const match = nodesRef.current.find((item) => item.id === nodeId);
    if (!match) return;

    const width = sizeRef.current.width;
    const targetZoom = panelOpen ? 1.9 : 1.75;
    const panelWidth = panelOpen ? Math.min(380, Math.max(320, width * 0.32)) : 0;
    const desiredScreenX = panelOpen ? Math.max(220, (width - panelWidth) / 2) : width / 2;
    const xOffset = (width / 2 - desiredScreenX) / targetZoom;

    setActiveId(nodeId);
    searchFocusUntilRef.current = 0;
    filterFocusUntilRef.current = 0;
    cameraTargetRef.current = {
      x: (match.x || 0) + xOffset,
      y: match.y || 0,
      zoom: targetZoom,
    };
  };

  const clearAiAssistFocus = () => {
    setActiveId(null);
    setHoverId(null);
    searchFocusUntilRef.current = 0;
    filterFocusUntilRef.current = 0;

    const candidateNodes = nodesRef.current;
    if (!candidateNodes.length) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    candidateNodes.forEach((node) => {
      minX = Math.min(minX, node.x || 0);
      minY = Math.min(minY, node.y || 0);
      maxX = Math.max(maxX, node.x || 0);
      maxY = Math.max(maxY, node.y || 0);
    });

    const { width, height } = sizeRef.current;
    const spanX = Math.max(220, maxX - minX + 220);
    const spanY = Math.max(220, maxY - minY + 220);
    const zoom = clamp(Math.min(width / spanX, height / spanY) * 0.62, 0.28, 3.2);
    cameraTargetRef.current = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
  };

  const updateAiAssistAnchor = () => {
    const currentAiAssist = aiAssistRef.current;
    if (!currentAiAssist?.isOpen || !currentAiAssist.nodeId) {
      if (aiAssistAnchorRef.current.visible) {
        const hiddenAnchor = { nodeX: 0, nodeY: 0, bubbleX: 0, bubbleY: 0, visible: false };
        aiAssistAnchorRef.current = hiddenAnchor;
        setAiAssistAnchor(hiddenAnchor);
      }
      return;
    }

    const node = nodesRef.current.find((item) => item.id === currentAiAssist.nodeId);
    if (!node) return;

    const { width, height } = sizeRef.current;
    const panelWidth = Math.min(360, Math.max(280, width - 32));
    const bubbleLeft = Math.max(16, width - panelWidth - 16);
    const point = screen(node, cameraRef.current, width, height);
    const nextAnchor = {
      nodeX: point.x,
      nodeY: point.y,
      bubbleX: bubbleLeft + 8,
      bubbleY: clamp(point.y, 116, height - 116),
      visible: point.x < bubbleLeft - 20 && point.y >= 48 && point.y <= height - 32,
    };
    const previousAnchor = aiAssistAnchorRef.current;
    const changed =
      previousAnchor.visible !== nextAnchor.visible ||
      Math.abs(previousAnchor.nodeX - nextAnchor.nodeX) > 3 ||
      Math.abs(previousAnchor.nodeY - nextAnchor.nodeY) > 3 ||
      Math.abs(previousAnchor.bubbleX - nextAnchor.bubbleX) > 3 ||
      Math.abs(previousAnchor.bubbleY - nextAnchor.bubbleY) > 3;

    if (changed) {
      aiAssistAnchorRef.current = nextAnchor;
      setAiAssistAnchor(nextAnchor);
    }
  };

  useEffect(() => {
    if (!aiAssist?.isOpen || !aiAssist.nodeId) return;
    const focus = () => focusNodeInFrame(aiAssist.nodeId as string, true);
    focus();
    const rafId = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(rafId);
  }, [aiAssist?.isOpen, aiAssist?.nodeId]);

  useEffect(() => {
    const isOpen = Boolean(aiAssist?.isOpen);
    if (!isOpen && previousAiAssistOpenRef.current) {
      clearAiAssistFocus();
    }
    previousAiAssistOpenRef.current = isOpen;
  }, [aiAssist?.isOpen]);

  useEffect(() => {
    updateAiAssistAnchor();
  }, [aiAssist?.isOpen, aiAssist?.nodeId]);

  // Focus a node requested from elsewhere (e.g. "View in topology" from Risk
  // Insight). The graph is often still loading/laying out when the request
  // arrives, so poll until the node has a real position before centering, and
  // only then mark the request handled.
  useEffect(() => {
    const target = focusNodeArn?.trim();
    if (!target) return;
    const normalized = target.toLowerCase();

    let attempts = 0;
    const maxAttempts = 50; // ~7.5s at 150ms intervals
    let timer = 0;

    const tryFocus = () => {
      attempts += 1;
      const match = renderGraph.nodes.find(
        (node) => (node.arn || '').toLowerCase() === normalized || node.id.toLowerCase() === normalized,
      );

      if (match) {
        const positioned = nodesRef.current.find((item) => item.id === match.id);
        const laidOut =
          positioned &&
          Number.isFinite(positioned.x) &&
          Number.isFinite(positioned.y) &&
          !(positioned.x === 0 && positioned.y === 0);

        if (laidOut) {
          focusNodeInFrame(match.id, !aiAssistRef.current?.isOpen);
          onFocusNodeHandled?.();
          return;
        }
        // Node exists but isn't positioned yet: keep the selection so it is
        // highlighted as soon as the layout settles.
        setActiveId(match.id);
      }

      if (attempts < maxAttempts) {
        timer = window.setTimeout(tryFocus, 150);
        return;
      }

      // Give up gracefully: center on whatever position we have, then release.
      if (match) {
        const positioned = nodesRef.current.find((item) => item.id === match.id);
        if (positioned) {
          cameraTargetRef.current = { x: positioned.x || 0, y: positioned.y || 0, zoom: 1.8 };
        }
      }
      onFocusNodeHandled?.();
    };

    // Small initial delay so a tab switch + first layout tick can begin.
    timer = window.setTimeout(tryFocus, 200);
    return () => window.clearTimeout(timer);
  }, [focusNodeArn, renderGraph.nodes, onFocusNodeHandled]);

  const buildAiAssistPrompt = (node: NodeRecord) => {
    const focusSignals = [
      node.dangerousPolicy ? 'privilege-escalation-capable policy' : null,
      node.trustExternal ? 'external trust relationship' : null,
      node.isHvt ? 'high-value target' : null,
      node.riskBand !== 'low' ? `${node.riskBand} canonical risk` : null,
    ].filter(Boolean);

    const policyActions = Array.isArray(node.properties.policy_actions)
      ? node.properties.policy_actions.slice(0, 8).map((value) => String(value))
      : [];
    const policyResources = Array.isArray(node.properties.policy_resources)
      ? node.properties.policy_resources.slice(0, 5).map((value) => String(value))
      : [];
    const policySummary = node.properties.policy_summary && typeof node.properties.policy_summary === 'object'
      ? node.properties.policy_summary as PolicySummaryRecord
      : null;
    const relatedIds = adjacency.neighbors.get(node.id) || new Set<string>();
    const relatedCounts = Array.from(relatedIds).reduce<Record<Filter, number>>((acc, relatedId) => {
      const relatedNode = nodeById.get(relatedId);
      if (!relatedNode) return acc;
      acc[relatedNode.category] += 1;
      return acc;
    }, { all: 0, substation: 0, transformer: 0, feeder: 0, meter: 0, other: 0 });

    const facts: string[] = [
      `type=${node.nodeType}`,
      `name=${node.fullLabel}`,
      `risk_score=${node.riskLevel}`,
      `risk_band=${node.riskBand}`,
    ];

    if (node.graphSignalLevel > 0) {
      facts.push(`graph_signal_level=${node.graphSignalLevel}`);
    }

    if (node.arn) {
      facts.push(`arn=${node.arn}`);
    }

    if (focusSignals.length) {
      facts.push(`signals=[${focusSignals.join('; ')}]`);
    }

    if (relatedIds.size) {
      facts.push(
        `neighbors=${relatedIds.size} (substations=${relatedCounts.substation}, transformers=${relatedCounts.transformer}, feeders=${relatedCounts.feeder}, meters=${relatedCounts.meter})`,
      );
    }

    if (policySummary?.statement_count) {
      facts.push(`policy_statements=${policySummary.statement_count}`);
    }

    if (policySummary?.has_wildcard_actions) {
      facts.push('wildcard_actions=true');
    }

    if (policySummary?.has_wildcard_resources) {
      facts.push('wildcard_resources=true');
    }

    if (policyActions.length) {
      facts.push(`allow_actions=[${policyActions.join(', ')}]`);
    }

    if (policyResources.length) {
      facts.push(`allow_resources=[${policyResources.join(', ')}]`);
    }

    if (Array.isArray(policySummary?.deny_actions) && policySummary?.deny_actions?.length) {
      facts.push(`deny_actions=[${policySummary.deny_actions.slice(0, 8).join(', ')}]`);
    }

    if (Array.isArray(policySummary?.deny_resources) && policySummary?.deny_resources?.length) {
      facts.push(`deny_resources=[${policySummary.deny_resources.slice(0, 5).join(', ')}]`);
    }

    return [
      'Selected node (context only, do not restate verbatim):',
      ...facts.map((line) => `- ${line}`),
    ].join('\n');
  };

  const requestAiAssist = (node: NodeRecord) => {
    if (!onRequestAiAssist) return;
    focusNodeInFrame(node.id, true);
    onRequestAiAssist({
      nodeId: node.id,
      nodeTitle: node.fullLabel,
      prompt: buildAiAssistPrompt(node),
    });
    setContextMenu({ visible: false, x: 0, y: 0, node: null });
  };

  const handlePathFindingNodeClick = async (node: NodeRecord) => {
    if (!pathFindingEnabledRef.current) return;

    const currentStart = pathFindingStartRef.current;
    const currentEnd = pathFindingEndRef.current;

    if (!currentStart) {
      setPathFindingStart(node);
      pathFindingStartRef.current = node;
      return;
    }

    if (!currentEnd && node.id !== currentStart.id) {
      const requestId = pathRequestSeqRef.current + 1;
      pathRequestSeqRef.current = requestId;
      setPathFindingEnd(node);
      pathFindingEndRef.current = node;
      setPathFindingLoading(true);
      try {
        const currentAccountId = selectedAwsAccountIdRef.current;
        if (!currentAccountId) {
          if (requestId === pathRequestSeqRef.current) {
            setFoundPath({ found: false, path: { nodes: [], edges: [] }, message: 'Select an AWS account first' });
          }
          return;
        }

        const result = await findCloudHoundPath({
          selectedAwsAccountId: currentAccountId,
          sourceArn: currentStart.arn,
          targetArn: node.arn,
        });
        if (requestId === pathRequestSeqRef.current && pathFindingEnabledRef.current) {
          setFoundPath(result);
        }
      } catch (err) {
        console.error('Path finding failed:', err);
        if (requestId === pathRequestSeqRef.current) {
          setFoundPath({ found: false, path: { nodes: [], edges: [] }, message: 'Path finding failed' });
        }
      } finally {
        if (requestId === pathRequestSeqRef.current) {
          setPathFindingLoading(false);
        }
      }
    }
  };

  const clearPathFinding = () => {
    pathRequestSeqRef.current += 1;
    setPathFindingStart(null);
    setPathFindingEnd(null);
    setFoundPath(null);
    setPathFindingLoading(false);
    pathFindingStartRef.current = null;
    pathFindingEndRef.current = null;
  };

  const openGraphFullscreen = async () => {
    const graphShell = graphShellRef.current;
    if (!graphShell) return;

    try {
      if (document.fullscreenElement === graphShell) {
        await document.exitFullscreen();
        return;
      }
      if (!document.fullscreenElement) {
        await graphShell.requestFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen request failed:', error);
    } finally {
      setEmptySpaceMenu({ visible: false, x: 0, y: 0 });
    }
  };

  const openGraphAiMode = () => {
    setEmptySpaceMenu({ visible: false, x: 0, y: 0 });
    onRequestGraphAiMode?.();
  };

  const showInspectorPanel = !aiAssist?.isOpen && isFullscreen;
  const isNodeAiAssistOpen = Boolean(aiAssist?.isOpen && aiAssist.mode === 'node');
  const isGraphAiAssistOpen = Boolean(aiAssist?.isOpen && (aiAssist.mode === 'graph' || aiAssist.mode === 'graph_chat'));
  const nodeAiAssist = isNodeAiAssistOpen ? aiAssist! : null;
  const graphAiAssist = isGraphAiAssistOpen ? aiAssist! : null;
  const isGraphConversationMode = Boolean(graphAiAssist && graphAiAssist.mode === 'graph_chat');
  const latestGraphAiMessage = graphAiAssist
    ? [...graphAiAssist.messages].reverse().find((msg) => msg.role === 'assistant') || graphAiAssist.messages[graphAiAssist.messages.length - 1]
    : null;
  const hideGraphChrome = isGraphAiAssistOpen;

  return (
    <div ref={graphShellRef} className="h-full flex flex-col">
      <style>{`
        @keyframes chat-thinking-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-3px); opacity: 1; } }
        .chat-thinking-dot { animation: chat-thinking-bounce 1.2s infinite ease-in-out; }
      `}</style>
      <div className={`relative overflow-hidden flex-1 border-none ${isLightMode ? 'bg-slate-100/85' : 'bg-premium-bg'}`}>
        <div className={`absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-2 border-b px-2 py-1.5 text-xs sm:px-3 sm:py-2 ${isLightMode ? 'border-slate-300/60 bg-slate-100/80 text-slate-700' : 'border-premium-border/50 bg-premium-sidebar/95 text-premium-text'}`}>
          {isOpsChrome && opsQueryOptions && onQueryChange ? (
            <div className={`flex shrink-0 rounded-md border p-0.5 ${isLightMode ? 'border-slate-300 bg-slate-200/60' : 'border-premium-border/55 bg-premium-surface/80'}`}>
              {opsQueryOptions.map((option) => {
                const active = graphQuery === option.key;
                const label = OPS_QUERY_LABELS[option.key] ?? option.label;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => onQueryChange(option.key)}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition ${
                      active
                        ? isLightMode
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'bg-premium-hover-strong text-premium-text'
                        : isLightMode
                          ? 'text-slate-600 hover:text-slate-900'
                          : 'text-premium-muted hover:text-premium-text'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : (
            <span>{isOpsChrome ? 'Network topology' : 'IAM Knowledge Graph'}</span>
          )}
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            {isOpsChrome && (
              <>
                <button type="button" onClick={reframe} className={`inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-[11px] font-medium transition ${isLightMode ? 'border-slate-300 bg-slate-100 text-slate-700 hover:border-slate-400 hover:bg-slate-200' : 'border-premium-border/55 bg-premium-card text-premium-text hover:border-premium-accent/70 hover:bg-premium-hover/90'}`}>Center</button>
                <button type="button" onClick={resetView} className={`inline-flex h-7 shrink-0 items-center rounded-md border px-2 text-[11px] font-medium transition ${isLightMode ? 'border-slate-300 bg-slate-100 text-slate-700 hover:border-slate-400 hover:bg-slate-200' : 'border-premium-border/55 bg-premium-card text-premium-text hover:border-premium-accent/70 hover:bg-premium-hover/90'}`}>Reset</button>
                <span className={`hidden truncate text-[11px] sm:inline ${isLightMode ? 'text-premium-muted-dim' : 'text-premium-muted'}`}>
                  {graph.metrics?.total_nodes ?? graph.nodes.length}n · {graph.metrics?.total_edges ?? graph.edges.length}e
                  {quality !== 'ultra' ? ` · ${modeLabel}` : ''}
                </span>
              </>
            )}
            <span className={`h-2 w-2 shrink-0 rounded-full ${animating ? 'animate-pulse bg-sky-400' : 'bg-emerald-400'}`} />
          </div>
        </div>

        <div ref={containerRef} className={`relative h-full w-full ${isOpsChrome ? 'min-h-0' : 'min-h-[760px]'}`} aria-label={isOpsChrome ? 'Grid network topology graph' : 'IAM topology graph canvas'}>
          <canvas ref={canvasRef} className="h-full w-full touch-none" />
        </div>

        {isNodeAiAssistOpen && aiAssistAnchor.visible && (
          <svg className="pointer-events-none absolute inset-0 z-[39]" viewBox={`0 0 ${sizeRef.current.width} ${sizeRef.current.height}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="aiAssistConnector" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="rgba(56,189,248,0.14)" />
                <stop offset="40%" stopColor="rgba(56,189,248,0.55)" />
                <stop offset="100%" stopColor="rgba(125,211,252,0.95)" />
              </linearGradient>
            </defs>
            <path
              d={`M ${aiAssistAnchor.nodeX} ${aiAssistAnchor.nodeY} C ${aiAssistAnchor.nodeX + 48} ${aiAssistAnchor.nodeY}, ${aiAssistAnchor.bubbleX - 72} ${aiAssistAnchor.bubbleY}, ${aiAssistAnchor.bubbleX} ${aiAssistAnchor.bubbleY}`}
              fill="none"
              stroke="url(#aiAssistConnector)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="6 8"
            />
            <circle cx={aiAssistAnchor.bubbleX} cy={aiAssistAnchor.bubbleY} r="4.5" fill="rgba(125,211,252,0.95)" />
          </svg>
        )}

        {isNodeAiAssistOpen && nodeAiAssist && (
          <div className="pointer-events-none absolute right-4 top-14 bottom-4 z-40 w-[clamp(300px,32vw,360px)] max-w-[calc(100%-2rem)]">
            <div className="pointer-events-auto flex h-full flex-col rounded-2xl border border-sky-500/25 bg-premium-card/95 p-4 shadow-[0_24px_80px_rgba(15,23,42,0.5)] backdrop-blur-xl">
              <div className="flex items-start justify-between gap-3 border-b border-premium-border/50/90 pb-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-sky-300/80">AI Assist</p>
                  <h3 className="mt-1 text-sm font-semibold text-premium-text">{nodeAiAssist.nodeTitle || 'Selected node'}</h3>
                  <p className="mt-1 text-xs text-premium-muted">Ask about risk, permissions, graph exposure, or safe remediation for this node.</p>
                </div>
                <button
                  type="button"
                  onClick={nodeAiAssist.onClose}
                  className="rounded-full border border-premium-border/70 bg-premium-card/95 px-2 py-1 text-xs text-premium-text-secondary transition hover:border-premium-border hover:text-premium-text"
                >
                  Close
                </button>
              </div>

              <div
                className="chat-scroll mt-4 flex-1 space-y-3 overflow-y-auto pr-1"
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
              >
                {nodeAiAssist.messages.length === 0 && !nodeAiAssist.loading ? (
                  <div className="rounded-xl border border-premium-border/50 bg-premium-surface/90 p-3 text-sm text-premium-muted">
                    Start the conversation for this node.
                  </div>
                ) : (
                  nodeAiAssist.messages.map((msg, index) => (
                    <div
                      key={`${msg.role}-${index}`}
                      className={`rounded-xl border px-3 py-2 ${msg.role === 'user' ? 'ml-8 border-premium-border/70 bg-premium-card' : 'mr-8 border-sky-500/20 bg-sky-950/10'}`}
                    >
                      <p className={`text-[11px] uppercase tracking-widest ${msg.role === 'user' ? 'text-premium-muted-dim' : 'text-sky-300/75'}`}>
                        {msg.role === 'user' ? 'You' : 'AI'}
                      </p>
                      {msg.role === 'assistant' ? (
                        <div className="mt-1 text-premium-text">
                          <AssistantRichText
                            content={msg.content}
                            className="text-sm text-premium-text"
                            mutedClassName="text-premium-text-secondary"
                          />
                        </div>
                      ) : (
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-premium-text">{msg.content}</p>
                      )}

                      {msg.remediationProposals && msg.remediationProposals.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {msg.remediationProposals.map((proposal) => {
                            const isApplied = nodeAiAssist.appliedProposalIds.has(proposal.proposal_id);
                            const isApplying = nodeAiAssist.applyingProposalId === proposal.proposal_id;
                            return (
                              <div key={proposal.proposal_id} className="rounded-lg border border-premium-border/70 bg-premium-card/95 px-3 py-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="text-sm text-premium-text">{proposal.title}</p>
                                    <p className="mt-1 text-xs leading-5 text-premium-text-secondary">{proposal.description}</p>
                                  </div>
                                  <span className="rounded-full border border-premium-border/55 bg-premium-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-premium-text-secondary">
                                    {proposal.action.replace(/_/g, ' ')}
                                  </span>
                                </div>
                                <div className="mt-3 flex items-center justify-between gap-3">
                                  <p className="text-[11px] text-premium-muted">
                                    {proposal.policy_name
                                      ? `${proposal.entity_type} ${proposal.entity_name} <- ${proposal.policy_name}`
                                      : `${proposal.entity_type} ${proposal.entity_name}`}
                                  </p>
                                  <button
                                    type="button"
                                    disabled={!nodeAiAssist.canApplyProposals || isApplied || isApplying}
                                    onClick={() => nodeAiAssist.onApplyProposal(proposal)}
                                    className={`rounded px-3 py-1.5 text-xs font-medium text-white transition ${isApplied ? 'bg-emerald-600' : 'bg-orange-500 hover:bg-orange-400 disabled:bg-premium-hover-strong'} disabled:cursor-not-allowed`}
                                  >
                                    {isApplied ? 'Applied' : isApplying ? 'Applying...' : nodeAiAssist.canApplyProposals ? (proposal.requires_confirmation ? 'Review' : 'Apply') : 'Admin only'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {msg.findings && msg.findings.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[11px] uppercase tracking-widest text-premium-muted-dim">Key Findings</p>
                          <ul className="ml-5 mt-1 list-disc space-y-1 text-xs text-premium-text-secondary">
                            {msg.findings.slice(0, 4).map((item, idx) => (
                              <li key={`graph-findings-${idx}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {msg.actions && msg.actions.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[11px] uppercase tracking-widest text-premium-muted-dim">Recommended Actions</p>
                          <ul className="ml-5 mt-1 list-disc space-y-1 text-xs text-premium-text-secondary">
                            {msg.actions.slice(0, 4).map((item, idx) => (
                              <li key={`graph-actions-${idx}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {msg.role === 'assistant' && msg.agent && (msg.agent.model || (msg.agent.toolsUsed && msg.agent.toolsUsed.length > 0)) && (
                        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-premium-border/50/80 pt-2">
                          {msg.agent.auto && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300"
                              title="Auto mode picked the provider for this question"
                            >
                              Auto
                            </span>
                          )}
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300"
                            title={msg.agent.provider ? `${msg.agent.provider} / ${msg.agent.model || ''}` : undefined}
                          >
                            <Sparkles className="h-3 w-3" />
                            {msg.agent.model || 'AI agent'}
                          </span>
                          {(msg.agent.fallbackChain || [])
                            .filter((step) => step.status === 'error')
                            .map((step, idx) => (
                              <span
                                key={`${step.provider}-${idx}`}
                                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300"
                                title={step.error || `${step.provider} unavailable`}
                              >
                                {step.provider} skipped
                              </span>
                            ))}
                          {(msg.agent.toolsUsed || []).map((tool) => (
                            <span
                              key={tool}
                              className="rounded-full bg-premium-hover/80 px-2 py-0.5 text-[10px] text-premium-text-secondary"
                              title="Tool the AI called to ground this answer"
                            >
                              {tool}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}

                {nodeAiAssist.loading && (
                  <div
                    className="mr-8 rounded-xl border border-sky-500/20 bg-sky-950/10 px-3 py-2"
                    role="status"
                    aria-live="polite"
                  >
                    <p className="text-[11px] uppercase tracking-widest text-sky-300/75">AI</p>
                    <div className="mt-1 flex items-center gap-2 text-sm text-premium-text-secondary">
                      <span>Thinking</span>
                      <span className="inline-flex items-end gap-1" aria-hidden="true">
                        <span className="chat-thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-300/80" style={{ animationDelay: '0s' }} />
                        <span className="chat-thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-300/80" style={{ animationDelay: '0.15s' }} />
                        <span className="chat-thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-300/80" style={{ animationDelay: '0.3s' }} />
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void nodeAiAssist.onSubmit();
                }}
                className="mt-4 flex items-center gap-2 border-t border-premium-border/50/90 pt-3"
              >
                <input
                  type="text"
                  value={nodeAiAssist.draft}
                  onChange={(event) => nodeAiAssist.onDraftChange(event.target.value)}
                  disabled={nodeAiAssist.loading}
                  placeholder="Ask about this node..."
                  className="flex-1 rounded-lg border border-premium-border/70 bg-premium-card px-3 py-2 text-sm text-premium-text outline-none transition focus:border-premium-accent/60"
                />
                <button
                  type="submit"
                  disabled={nodeAiAssist.loading || !nodeAiAssist.draft.trim()}
                  className="rounded-lg bg-premium-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-premium-accent-hover disabled:cursor-not-allowed disabled:bg-premium-hover-strong"
                >
                  {nodeAiAssist.loading ? 'Thinking...' : 'Send'}
                </button>
              </form>
            </div>
          </div>
        )}

        {isGraphAiAssistOpen && graphAiAssist && (
          <div className="pointer-events-none absolute inset-x-0 top-14 z-40 flex justify-center px-4">
            <div className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-sky-500/25 bg-premium-card/98 px-4 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.52)] backdrop-blur-xl">
              <div className="flex items-start justify-between gap-4 border-b border-premium-border/50/90 pb-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-sky-300/80">Graph AI Mode</p>
                  <h3 className="mt-1 text-sm font-semibold text-premium-text">{graphAiAssist.nodeTitle || 'Current graph view'}</h3>
                  <p className="mt-1 text-xs text-premium-muted">
                    {isGraphConversationMode
                      ? 'Ask questions about the current graph and get contextual responses with follow-ups.'
                      : 'Give an instruction for this graph. The AI will update the graph view instead of holding a conversation.'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => graphAiAssist.onSwitchMode?.('graph')}
                    disabled={graphAiAssist.loading || graphAiAssist.mode === 'graph'}
                    className="rounded-full border border-premium-border/70 bg-premium-card/95 px-2 py-1 text-xs text-premium-text-secondary transition hover:border-premium-border hover:text-premium-text disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Instruction
                  </button>
                  <button
                    type="button"
                    onClick={() => graphAiAssist.onSwitchMode?.('graph_chat')}
                    disabled={graphAiAssist.loading || graphAiAssist.mode === 'graph_chat'}
                    className="rounded-full border border-premium-border/70 bg-premium-card/95 px-2 py-1 text-xs text-premium-text-secondary transition hover:border-premium-border hover:text-premium-text disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Conversation
                  </button>
                  <button
                    type="button"
                    onClick={graphAiAssist.onClose}
                    className="rounded-full border border-premium-border/70 bg-premium-card/95 px-2 py-1 text-xs text-premium-text-secondary transition hover:border-premium-border hover:text-premium-text"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_0.9fr]">
                <div className="min-h-[150px] rounded-xl border border-premium-border/50 bg-premium-surface/90 p-3">
                  <p className="text-[11px] uppercase tracking-widest text-premium-muted-dim">
                    {isGraphConversationMode ? 'Conversation' : 'Last instruction'}
                  </p>
                  {isGraphConversationMode ? (
                    <div className="mt-2 max-h-[180px] space-y-2 overflow-y-auto pr-1 text-xs" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                      {graphAiAssist.messages.length ? graphAiAssist.messages.map((msg, idx) => (
                        <div key={`graph-mode-message-${idx}`} className={`rounded border px-2 py-1.5 ${msg.role === 'user' ? 'border-premium-border/70 bg-premium-card text-premium-text-secondary' : 'border-sky-500/20 bg-sky-950/15 text-premium-text'}`}>
                          <p className="text-[10px] uppercase tracking-wider text-premium-muted">{msg.role === 'user' ? 'You' : 'AI'}</p>
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap">{msg.content}</p>
                        </div>
                      )) : (
                        <p className="text-sm text-premium-muted">No conversation yet. Ask a question about the graph.</p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 line-clamp-5 text-sm text-premium-text">
                      {graphAiAssist.lastInstruction || 'No instruction sent yet. Try “show me the most dangerous trust paths” or “focus on roles connected to dangerous policies”.'}
                    </p>
                  )}
                </div>
                <div className="min-h-[150px] rounded-xl border border-sky-500/20 bg-sky-950/10 p-3">
                  <p className="text-[11px] uppercase tracking-widest text-sky-300/75">
                    {isGraphConversationMode ? 'AI Response' : 'Graph status'}
                  </p>
                  {latestGraphAiMessage ? (
                    <div className="mt-2 text-premium-text">
                      <p className="text-sm text-premium-text">{latestGraphAiMessage.content}</p>
                      {latestGraphAiMessage.findings && latestGraphAiMessage.findings!.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[11px] uppercase tracking-widest text-premium-muted-dim">Key Findings</p>
                          <ul className="ml-5 mt-1 list-disc space-y-1 text-xs text-premium-text-secondary">
                            {latestGraphAiMessage.findings!.slice(0, 4).map((item, idx) => (
                              <li key={`graph-mode-findings-${idx}`}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {latestGraphAiMessage.suggestionPrompts && latestGraphAiMessage.suggestionPrompts!.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[11px] uppercase tracking-widest text-premium-muted-dim">Did You Mean</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {latestGraphAiMessage.suggestionPrompts!.slice(0, 6).map((prompt, idx) => (
                              <button
                                key={`graph-mode-suggestion-${idx}`}
                                type="button"
                                disabled={graphAiAssist.loading}
                                onClick={() => graphAiAssist.onDraftChange(prompt)}
                                className="rounded-full border border-sky-500/35 bg-sky-500/12 px-2.5 py-1 text-[11px] text-sky-100 transition hover:border-sky-400/65 hover:bg-sky-500/22 disabled:cursor-not-allowed disabled:opacity-60"
                                title="Use this prompt"
                              >
                                {prompt}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {latestGraphAiMessage.modeSuggestions && latestGraphAiMessage.modeSuggestions!.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[11px] uppercase tracking-widest text-premium-muted-dim">Mode Suggestion</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {latestGraphAiMessage.modeSuggestions!.map((suggestion) => (
                              <button
                                key={`graph-mode-switch-${suggestion.mode}`}
                                type="button"
                                disabled={graphAiAssist.loading}
                                onClick={() => graphAiAssist.onSwitchMode?.(suggestion.mode)}
                                className="rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2.5 py-1 text-[11px] text-emerald-100 transition hover:border-emerald-400/65 hover:bg-emerald-500/22 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {suggestion.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-premium-muted">
                      {isGraphConversationMode
                        ? 'Ask a graph question to start a conversation.'
                        : 'The graph will update directly after each instruction.'}
                    </p>
                  )}
                </div>
              </div>

              {graphAiAssist.loading && (
                <div
                  className="mt-3 rounded-xl border border-sky-500/20 bg-sky-950/10 px-3 py-2"
                  role="status"
                  aria-live="polite"
                >
                  <p className="text-[11px] uppercase tracking-widest text-sky-300/75">AI</p>
                  <div className="mt-1 flex items-center gap-2 text-sm text-premium-text-secondary">
                    <span>Thinking</span>
                    <span className="inline-flex items-end gap-1" aria-hidden="true">
                      <span className="chat-thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-300/80" style={{ animationDelay: '0s' }} />
                      <span className="chat-thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-300/80" style={{ animationDelay: '0.15s' }} />
                      <span className="chat-thinking-dot inline-block h-1.5 w-1.5 rounded-full bg-sky-300/80" style={{ animationDelay: '0.3s' }} />
                    </span>
                  </div>
                </div>
              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void graphAiAssist.onSubmit();
                }}
                className="mt-4 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={graphAiAssist.draft}
                  onChange={(event) => graphAiAssist.onDraftChange(event.target.value)}
                  disabled={graphAiAssist.loading}
                  placeholder={isGraphConversationMode ? 'Ask a question about this graph...' : 'Give an instruction for this graph...'}
                  className="flex-1 rounded-lg border border-premium-border/70 bg-premium-card px-3 py-2 text-sm text-premium-text outline-none transition focus:border-premium-accent/60"
                />
                <button
                  type="submit"
                  disabled={graphAiAssist.loading || !graphAiAssist.draft.trim()}
                  className="rounded-lg bg-premium-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-premium-accent-hover disabled:cursor-not-allowed disabled:bg-premium-hover-strong"
                >
                  {graphAiAssist.loading ? 'Thinking...' : 'Send'}
                </button>
              </form>
            </div>
          </div>
        )}

        {emptySpaceMenu.visible && !isOpsChrome && (
          <div
            className={`absolute z-50 w-[220px] rounded-xl border shadow-2xl ${isLightMode ? 'border-slate-300 bg-white/95' : 'border-premium-border/55 bg-premium-card/98'}`}
            style={{ left: emptySpaceMenu.x, top: emptySpaceMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-3 py-2">
              <p className={`text-[11px] uppercase tracking-[0.2em] ${isLightMode ? 'text-premium-muted-dim' : 'text-premium-muted'}`}>Graph Actions</p>
            </div>
            <div className={`border-t ${isLightMode ? 'border-slate-200' : 'border-premium-border/80'}`} />
            <button
              type="button"
              onClick={() => void openGraphFullscreen()}
              className={`block w-full px-3 py-2 text-left text-sm transition ${isLightMode ? 'text-slate-900 hover:bg-slate-100' : 'text-premium-text hover:bg-premium-surface'}`}
            >
              Full screen
            </button>
            <button
              type="button"
              onClick={openGraphAiMode}
              className={`block w-full px-3 py-2 text-left text-sm transition ${isLightMode ? 'text-sky-700 hover:bg-sky-50' : 'text-sky-300 hover:bg-sky-950/20'}`}
            >
              AI mode
            </button>
          </div>
        )}

        {!hideGraphChrome && !isOpsChrome && (
          <div className="pointer-events-none absolute inset-0 z-30 p-3 pt-12 sm:p-4 sm:pt-12">
            <div className={`pointer-events-auto rounded-xl border p-2.5 backdrop-blur-lg ${isFullscreen ? 'max-w-[min(760px,max(240px,calc(100%-clamp(300px,32vw,360px)-284px)))]' : 'max-w-[min(760px,max(240px,calc(100%-268px)))] lg:max-w-[min(760px,max(240px,calc(100%-clamp(300px,32vw,360px)-284px)))]'} ${isLightMode ? 'border-slate-300/60 bg-slate-100/80' : 'border-premium-border/50 bg-premium-card/92'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitSearch();
                  }
                }}
                placeholder="Search identities, roles, policies, ARNs (press Enter)"
                className={`min-w-[220px] flex-1 rounded-md border px-3 py-1.5 text-sm outline-none focus:border-premium-accent/60 ${isLightMode ? 'border-slate-300 bg-slate-50 text-slate-900 placeholder:text-premium-muted-dim' : 'border-premium-border/55 bg-premium-surface text-premium-text placeholder:text-premium-muted-dim'}`}
              />
              <button type="button" onClick={reframe} className={`inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium transition ${isLightMode ? 'border-slate-300 bg-slate-100 text-slate-700 hover:border-slate-400 hover:bg-slate-200' : 'border-premium-border/55 bg-premium-card text-premium-text hover:border-premium-accent/70 hover:bg-premium-hover/90'}`}>Center</button>
              <button type="button" onClick={resetView} className={`inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium transition ${isLightMode ? 'border-slate-300 bg-slate-100 text-slate-700 hover:border-slate-400 hover:bg-slate-200' : 'border-premium-border/55 bg-premium-card text-premium-text hover:border-premium-accent/70 hover:bg-premium-hover/90'}`}>Reset</button>
              <button 
                type="button" 
                onClick={() => {
                  setPathFindingEnabled(!pathFindingEnabled);
                  clearPathFinding();
                }} 
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition ${pathFindingEnabled ? (isLightMode ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-emerald-500/70 bg-emerald-500/18 text-emerald-100 hover:border-emerald-400/70') : (isLightMode ? 'border-slate-300 bg-slate-100 text-slate-700 hover:border-slate-400 hover:bg-slate-200' : 'border-premium-border/55 bg-premium-card text-premium-text hover:border-premium-accent/70 hover:bg-premium-hover/90')}`}
              >
                <GitBranch className="w-3.5 h-3.5" />
                Path
              </button>
            </div>

            {pathFindingEnabled && (
              <div className="mt-2 rounded-lg border border-emerald-700/50 bg-emerald-950/30 p-2.5">
                <p className="text-[11px] font-semibold text-emerald-200 mb-2">Path Finding Mode</p>
                <div className="space-y-1.5 text-xs text-emerald-100/80">
                  <div>Start: {pathFindingStart ? pathFindingStart.label : 'Click a node'}</div>
                  <div>End: {pathFindingEnd ? pathFindingEnd.label : 'Click another node'}</div>
                  {pathFindingLoading && <div className="text-sky-300">Finding path...</div>}
                  {foundPath && (
                    <div className="text-emerald-200 font-semibold">
                      {foundPath.found ? `✓ Path found (${foundPath.path.nodes.length} nodes)` : '✗ No path found'}
                    </div>
                  )}
                  {(pathFindingStart || pathFindingEnd) && (
                    <button 
                      type="button" 
                      onClick={clearPathFinding}
                      className="text-emerald-300 hover:text-emerald-100 text-[10px] font-medium"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {isAiQueryGraph && (
              <div className={`mt-2 rounded-lg border px-3 py-2 ${isLightMode ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-sky-500/35 bg-sky-950/25 text-sky-100'}`}>
                <p className={`text-[11px] uppercase tracking-[0.2em] ${isLightMode ? 'text-sky-700' : 'text-sky-300/80'}`}>AI Query Result</p>
                <p className="mt-1 text-sm font-medium">{aiQueryTitle}</p>
                <p className={`mt-1 text-xs ${isLightMode ? 'text-sky-800/80' : 'text-sky-100/75'}`}>
                  {graph.nodes.length} nodes and {graph.edges.length} edges are highlighted from the generated graph query.
                </p>
              </div>
            )}


            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {([
                ['all', 'All', typeCounts.all], ['substation', 'Substations', typeCounts.substation], ['transformer', 'Transformers', typeCounts.transformer], ['feeder', 'Feeders', typeCounts.feeder], ['meter', 'Meters', typeCounts.meter], ['other', 'Other', typeCounts.other],
              ] as Array<[Filter, string, number]>).map(([key, label, count]) => (
                <button key={key} type="button" onClick={() => toggleFilter(key)} className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition ${isFilterActive(key) ? 'border-premium-accent/70 bg-premium-accent/18 text-premium-text' : 'border-premium-border/55 bg-premium-surface/90 text-premium-text-secondary hover:border-premium-border hover:bg-premium-hover/80 hover:text-premium-text'}`}>
                  <span>{label}</span>
                  <span className={`inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] ${isFilterActive(key) ? 'bg-premium-accent/25 text-premium-text' : 'bg-premium-hover-strong/70 text-premium-text-secondary'}`}>{count}</span>
                </button>
              ))}
              <div className="ml-auto hidden items-center gap-3 text-[11px] text-premium-muted sm:flex">
                <span>N {graph.metrics?.total_nodes ?? graph.nodes.length}</span>
                <span>E {graph.metrics?.total_edges ?? graph.edges.length}</span>
                <span>Risk {graph.metrics?.high_risk_entities ?? 0}</span>
                <span>HVT {graph.metrics?.hvt_count ?? 0}</span>
                <span>Trust {graph.metrics?.external_trust_roles ?? 0}</span>
                <span>Esc {graph.metrics?.privilege_escalation_paths ?? 0}</span>
                <span>{modeLabel}</span>
              </div>
            </div>

            {searchInput.trim() && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {searchMatches.slice(0, 5).map((node) => (
                  <button key={node.id} type="button" onClick={() => { setActiveId(node.id); const match = nodesRef.current.find((item) => item.id === node.id); if (match) cameraTargetRef.current = { x: match.x || 0, y: match.y || 0, zoom: 1.8 }; }} className="max-w-[240px] truncate rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-100 transition hover:border-sky-400/60 hover:bg-sky-500/20">{node.fullLabel}</button>
                ))}
              </div>
            )}
            </div>
          </div>
        )}

        {!hideGraphChrome && !isOpsChrome && (
          <div className={`pointer-events-none absolute top-14 z-50 ${showInspectorPanel ? 'right-[calc(clamp(300px,32vw,360px)+32px)]' : 'right-4 lg:right-[calc(clamp(300px,32vw,360px)+32px)]'}`}>
            <div className={`pointer-events-auto w-[228px] overflow-hidden rounded-xl border bg-premium-card/98 p-3 text-sm backdrop-blur-xl transition-colors duration-300 ${controlsPanelOpen ? 'border-premium-accent/30 shadow-[0_20px_60px_rgba(212,212,212,0.08)]' : 'border-premium-border/55 shadow-lg'}`}>
            <button
              type="button"
              onClick={() => setControlsPanelOpen((open) => !open)}
              className="flex w-full items-center justify-between rounded-lg border border-premium-border/50 bg-premium-surface/70 px-2.5 py-2 text-left transition-colors duration-300 hover:border-premium-border/80 hover:bg-premium-surface/90"
              aria-label={controlsPanelOpen ? 'Collapse graph controls' : 'Expand graph controls'}
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-premium-text-secondary">Graph controls</p>
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-full border border-premium-border/55 bg-premium-surface/90 text-premium-text-secondary transition-transform duration-300 ease-out ${controlsPanelOpen ? 'rotate-180' : 'rotate-0'}`}
                aria-hidden="true"
              >
                ▾
              </span>
            </button>
            <div className={`origin-top overflow-hidden pr-1 transition-[max-height,opacity,margin] duration-300 ease-out ${controlsPanelOpen ? 'mt-2 max-h-[70vh] opacity-100' : 'pointer-events-none mt-0 max-h-0 opacity-0'}`}>
              {/* Display section */}
              <button type="button" onClick={() => setDisplaySectionOpen((o) => !o)} className="mb-2 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-premium-text-secondary">
                <span>Display</span><span className="text-premium-muted-dim">{displaySectionOpen ? '▾' : '▸'}</span>
              </button>
              {displaySectionOpen && (
                <div className="space-y-3 mb-4">
                  <div className="flex items-center justify-between">
                    <span className="text-premium-text-secondary">Arrows</span>
                    <button
                      type="button"
                      onClick={() => setShowArrows((v) => !v)}
                      aria-pressed={showArrows}
                      className={`relative h-5 w-10 rounded-full border transition-colors duration-200 ${showArrows ? 'border-sky-400/80 bg-sky-500' : 'border-slate-600/90 bg-premium-hover-strong'}`}
                    >
                      <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-out ${showArrows ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-premium-text-secondary">Heat map</span>
                      <p className="text-[10px] text-premium-muted-dim">Color nodes by canonical risk</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setHeatMapEnabled((v) => !v)}
                      aria-pressed={heatMapEnabled}
                      className={`relative h-5 w-10 rounded-full border transition-colors duration-200 ${heatMapEnabled ? 'border-orange-400/80 bg-orange-500' : 'border-slate-600/90 bg-premium-hover-strong'}`}
                    >
                      <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ease-out ${heatMapEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Text fade threshold</span><span>{textFadeZoom.toFixed(1)}×</span></div>
                    <input type="range" min={0.2} max={4} step={0.1} value={textFadeZoom} onChange={(e) => setTextFadeZoom(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Node size</span><span>{nodeSizeMult.toFixed(1)}×</span></div>
                    <input type="range" min={0.4} max={3} step={0.1} value={nodeSizeMult} onChange={(e) => setNodeSizeMult(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Link thickness</span><span>{linkThickness.toFixed(2)}×</span></div>
                    <input type="range" min={0.05} max={4} step={0.05} value={linkThickness} onChange={(e) => setLinkThickness(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Link text visibility</span><span>{edgeVisibility.toFixed(2)}x</span></div>
                    <input type="range" min={0.5} max={2} step={0.05} value={edgeVisibility} onChange={(e) => setEdgeVisibility(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                  <button type="button" onClick={() => { simRef.current?.alphaTarget(0.22).restart(); setAnimating(true); }} className="w-full rounded-md bg-sky-600 py-2 font-semibold text-white hover:bg-sky-500 transition">Animate</button>
                </div>
              )}
              {/* Forces section */}
              <button type="button" onClick={() => setForcesSectionOpen((o) => !o)} className="mb-2 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-premium-text-secondary">
                <span>Forces</span><span className="text-premium-muted-dim">{forcesSectionOpen ? '▾' : '▸'}</span>
              </button>
              {forcesSectionOpen && (
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Center force</span><span>{centerForce.toFixed(2)}</span></div>
                    <input type="range" min={0} max={1.25} step={0.01} value={centerForce} onChange={(e) => setCenterForce(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Repel force</span><span>{repelForce.toFixed(2)}</span></div>
                    <input type="range" min={0} max={1.5} step={0.01} value={repelForce} onChange={(e) => setRepelForce(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Link force</span><span>{linkStrength.toFixed(2)}</span></div>
                    <input type="range" min={0} max={1} step={0.01} value={linkStrength} onChange={(e) => setLinkStrength(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-premium-muted mb-1"><span>Link distance</span><span>{linkDist}</span></div>
                    <input type="range" min={10} max={300} step={5} value={linkDist} onChange={(e) => setLinkDist(Number(e.target.value))} className="w-full accent-sky-500" />
                  </div>
                </div>
              )}
            </div>
            </div>
          </div>
        )}

        <style>{`
          .inspector-scroll::-webkit-scrollbar {
            display: none;
          }
          .chat-scroll::-webkit-scrollbar {
            display: none;
          }
          @keyframes chat-thinking-bounce {
            0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
            40% { transform: translateY(-3px); opacity: 1; }
          }
          .chat-thinking-dot {
            animation: chat-thinking-bounce 1.2s infinite ease-in-out;
          }
        `}</style>
        {!isNodeAiAssistOpen && !hideGraphChrome && !isOpsChrome && (
          <div className={`pointer-events-none absolute right-4 top-14 bottom-4 z-30 ${isFullscreen ? 'block w-[clamp(300px,32vw,360px)] max-w-[calc(100%-2rem)]' : 'hidden w-[clamp(300px,32vw,360px)] lg:block'}`}>
            <div className="pointer-events-auto h-full">
              <div className="flex h-full flex-col rounded-2xl border border-premium-border/55 bg-premium-card/95 p-4 shadow-premium backdrop-blur-xl">
                <div className="inspector-scroll min-h-0 space-y-4 overflow-y-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-premium-muted-dim">Inspector</p>
                <div className="mt-3 space-y-3">
                  {selectedNode ? (
                    <>
                      <div><h3 className="text-lg font-semibold text-premium-text">{selectedNode.fullLabel}</h3><p className="text-sm text-premium-muted">{selectedNode.nodeType || selectedNode.category}</p></div>
                      <div className={`rounded-lg border px-3 py-2 text-sm ${
                        selectedNode.riskBand === 'critical'
                          ? 'text-red-300 border-red-800/70 bg-red-950/30'
                          : selectedNode.riskBand === 'high'
                            ? 'text-orange-300 border-orange-800/70 bg-orange-950/30'
                            : selectedNode.riskBand === 'medium'
                              ? 'text-amber-300 border-amber-800/70 bg-amber-950/30'
                              : 'text-premium-text-secondary border-premium-border/50 bg-premium-surface/90'
                      }`}>Risk level: {selectedNode.riskLevel.toFixed(1)} ({selectedNode.riskBand})</div>
                      {onRequestAiAssist && (
                        <button
                          type="button"
                          onClick={() => requestAiAssist(selectedNode)}
                          className="rounded-lg bg-premium-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-premium-accent-hover"
                        >
                          Ask AI About This Node
                        </button>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {selectedNode.isHvt && <div className="rounded-lg border border-amber-700/70 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">High-value target</div>}
                        {selectedNode.trustExternal && <div className="rounded-lg border border-orange-700/70 bg-orange-950/30 px-3 py-2 text-xs text-orange-200">External trust</div>}
                        {selectedNode.dangerousPolicy && <div className="rounded-lg border border-red-700/70 bg-red-950/30 px-3 py-2 text-xs text-red-200">Privilege escalation policy</div>}
                        {selectedPolicySummary?.has_wildcard_actions && <div className="rounded-lg border border-sky-700/70 bg-sky-950/25 px-3 py-2 text-xs text-sky-200">Wildcard actions</div>}
                        {selectedPolicySummary?.has_wildcard_resources && <div className="rounded-lg border border-sky-700/70 bg-sky-950/25 px-3 py-2 text-xs text-sky-200">Wildcard resources</div>}
                      </div>
                      <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary"><p className="font-medium text-premium-text">Focus depth</p><p className="mt-1 text-premium-muted">Current expansion radius is {depth} hop{depth === 1 ? '' : 's'}</p></div>
                      {selectedNode.arn && <div className="break-all rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-muted">{selectedNode.arn}</div>}
                      {(selectedPolicySummary || selectedPolicyActions.length > 0 || selectedPolicyResources.length > 0) && (
                        <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary">
                          <p className="font-medium text-premium-text">Policy summary</p>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                            <div className="rounded border border-premium-border/50 bg-premium-surface/85 px-2 py-2 text-premium-text-secondary">
                              <span className="text-premium-muted-dim">Statements</span>
                              <p className="mt-1 text-sm text-premium-text">{selectedPolicySummary?.statement_count ?? 0}</p>
                            </div>
                            <div className="rounded border border-premium-border/50 bg-premium-surface/85 px-2 py-2 text-premium-text-secondary">
                              <span className="text-premium-muted-dim">Allowed actions</span>
                              <p className="mt-1 text-sm text-premium-text">{selectedPolicyActions.length}</p>
                            </div>
                          </div>
                          {selectedPolicyActions.length > 0 && (
                            <div className="mt-3">
                              <p className="text-[10px] uppercase tracking-wider text-premium-muted-dim">Allowed actions</p>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {selectedPolicyActions.slice(0, 8).map((action) => (
                                  <span key={action} className="rounded-full border border-premium-border/55 bg-premium-surface px-2 py-1 text-[10px] text-premium-text-secondary">{action}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {selectedPolicyResources.length > 0 && (
                            <div className="mt-3">
                              <p className="text-[10px] uppercase tracking-wider text-premium-muted-dim">Allowed resources</p>
                              <div className="mt-2 space-y-1">
                                {selectedPolicyResources.slice(0, 5).map((resource) => (
                                  <div key={resource} className="break-all rounded bg-premium-surface/85 px-2 py-1 text-[11px] text-premium-text-secondary">{resource}</div>
                                ))}
                              </div>
                            </div>
                          )}
                          {selectedDeniedActions.length > 0 && (
                            <div className="mt-3">
                              <p className="text-[10px] uppercase tracking-wider text-premium-muted-dim">Denied actions</p>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {selectedDeniedActions.slice(0, 6).map((action) => (
                                  <span key={action} className="rounded-full border border-red-800/70 bg-red-950/20 px-2 py-1 text-[10px] text-red-200">{action}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {selectedDeniedResources.length > 0 && (
                            <div className="mt-3">
                              <p className="text-[10px] uppercase tracking-wider text-premium-muted-dim">Denied resources</p>
                              <div className="mt-2 space-y-1">
                                {selectedDeniedResources.slice(0, 4).map((resource) => (
                                  <div key={resource} className="break-all rounded bg-red-950/15 px-2 py-1 text-[11px] text-red-200">{resource}</div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {selectedNode && (
                        <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary">
                          <p className="font-medium text-premium-text">Asset detail</p>
                          <p className="mt-2 font-mono text-[11px] text-premium-muted">{selectedNode.id}</p>
                          <p className="mt-1">Validation: {String(selectedNode.properties.validation ?? 'APPROVED')}</p>
                          <p className="mt-1">Connected: {selectedNode.properties.connected === false ? 'no' : 'yes'}</p>
                          <p className="mt-1">On trace path: {selectedNode.properties.traced ? 'yes' : 'no'}</p>
                          <p className="mt-1">Asset class: {selectedNode.category}</p>
                        </div>
                      )}
                      {selectedNode && (
                        <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary">
                          <p className="font-medium text-premium-text">Registry record (placeholder)</p>
                          {policyDocumentLoading && (
                            <p className="mt-2 text-[11px] text-premium-muted">Loading policy JSON from AWS IAM...</p>
                          )}
                          {policyDocumentError && !policyDocumentLoading && (
                            <p className="mt-2 text-[11px] text-rose-300">{policyDocumentError}</p>
                          )}
                          {policyDocument?.document && !policyDocumentLoading && (
                            <>
                              <p className="mt-2 text-[10px] uppercase tracking-wider text-premium-muted-dim">
                                Version {policyDocument.default_version_id}
                              </p>
                              <pre className="mt-2 max-h-56 overflow-auto rounded border border-premium-border/50 bg-premium-surface/90 p-2 text-[10px] leading-relaxed text-premium-text-secondary">
                                {JSON.stringify(policyDocument.document, null, 2)}
                              </pre>
                            </>
                          )}
                        </div>
                      )}
                      <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary">
                        <p className="font-medium text-premium-text">Connected entity mix</p>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                          <div className="rounded border border-premium-border/50 bg-premium-surface/85 px-2 py-2"><span className="text-premium-muted-dim">Substations</span><p className="mt-1 text-sm text-premium-text">{selectedRelationshipCounts.substation}</p></div>
                          <div className="rounded border border-premium-border/50 bg-premium-surface/85 px-2 py-2"><span className="text-premium-muted-dim">Transformers</span><p className="mt-1 text-sm text-premium-text">{selectedRelationshipCounts.transformer}</p></div>
                          <div className="rounded border border-premium-border/50 bg-premium-surface/85 px-2 py-2"><span className="text-premium-muted-dim">Feeders</span><p className="mt-1 text-sm text-premium-text">{selectedRelationshipCounts.feeder}</p></div>
                          <div className="rounded border border-premium-border/50 bg-premium-surface/85 px-2 py-2"><span className="text-premium-muted-dim">Meters</span><p className="mt-1 text-sm text-premium-text">{selectedRelationshipCounts.meter}</p></div>
                        </div>
                      </div>
                      <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary"><p className="font-medium text-premium-text">Connected entities</p><div className="mt-2 space-y-2">{relatedNodeGroups.length ? relatedNodeGroups.map((group) => <div key={group.category}><p className="mb-1 text-[10px] uppercase tracking-wider text-premium-muted-dim">{group.label} ({group.nodes.length})</p><div className="space-y-1">{group.nodes.slice(0, 5).map((node) => <button key={node.id} type="button" onClick={() => { setActiveId(node.id); const match = nodesRef.current.find((item) => item.id === node.id); if (match) cameraTargetRef.current = { x: match.x || 0, y: match.y || 0, zoom: 1.8 }; }} className="block w-full truncate rounded bg-premium-surface/85 px-2 py-1 text-left text-premium-text-secondary transition hover:bg-premium-hover hover:text-premium-text">{node.fullLabel}</button>)}</div></div>) : <p className="text-premium-muted-dim">No connected entities</p>}</div></div>
                      <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary"><p className="font-medium text-premium-text">Relationship count</p><p className="mt-1 text-premium-muted">{selectedEdges} nearby relationship{selectedEdges === 1 ? '' : 's'}</p></div>
                      {!!selectedEscalationDetails.length && (
                        <div className="rounded-lg border border-red-800/70 bg-red-950/20 p-3 text-xs text-red-100">
                          <p className="font-medium text-red-200">Escalation chain explanation</p>
                          <div className="mt-2 space-y-2">
                            {selectedEscalationDetails.slice(0, 4).map((item) => (
                              <div key={item.id} className="rounded border border-red-800/60 bg-red-950/20 px-2.5 py-2">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-red-300">{escalationTypeLabel(item.type)}</p>
                                <p className="mt-1 text-red-100/95">{item.explanation}</p>
                                <p className="mt-1 text-[11px] text-red-200/85">{item.sourceName} {'->'} {item.targetName}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : <div className="rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-sm text-premium-muted">Select a node to inspect its neighborhood.</div>}
                </div>
              </div>
              <div><p className="text-[11px] uppercase tracking-[0.24em] text-premium-muted-dim">Focus controls</p><div className="mt-3 space-y-3 rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3"><div><div className="mb-1 flex items-center justify-between text-xs text-premium-muted"><span>Depth</span><span>{depth} hops</span></div><input type="range" min={1} max={4} value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="w-full accent-sky-400" /></div><div className="flex items-center justify-between text-xs text-premium-muted"><span>Focused node</span><span className="truncate pl-2 text-premium-text-secondary">{focusId ? (selectedNode?.label || selectedNode?.fullLabel || focusId) : 'None'}</span></div></div></div>
              <div><p className="text-[11px] uppercase tracking-[0.24em] text-premium-muted-dim">Legend</p><div className="mt-3 space-y-1 text-sm text-premium-text-secondary"><p className="text-[10px] uppercase tracking-widest text-premium-muted-dim mb-1">Node types</p><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-3 h-3 rounded-full bg-[#9ec5ff]" /><span>User</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-3 h-3 rounded-full bg-[#c9a9ff]" /><span>Role</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-3 h-3 rounded-full bg-[#7fd6c9]" /><span>Policy</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-3 h-3 rounded-full bg-[#ffd08a]" /><span>Group</span></div><p className="text-[10px] uppercase tracking-widest text-premium-muted-dim mt-2 mb-1">Security signals</p><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-4 h-4 rounded-full border-2 border-[#f4d06f]" /><span>High-value target</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-4 h-4 rounded-full border-2 border-[#ff915a]" /><span>External trust role</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-4 h-4 rounded-full border-2 border-[#ef4444] bg-[#ef4444]/20" /><span>Dangerous policy</span></div><p className="text-[10px] uppercase tracking-widest text-premium-muted-dim mt-2 mb-1">Edge relationships</p><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-6 h-1 rounded" style={{backgroundColor:'#ef4444'}} /><span>Privilege escalation path</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-6 h-1 rounded" style={{backgroundColor:'#7fd6c9'}} /><span>Attached / Has Policy</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-6 h-1 rounded" style={{backgroundColor:'#ff915a'}} /><span>Assumes / Trusts Role</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-6 h-1 rounded" style={{backgroundColor:'#ffd08a'}} /><span>Member of Group</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-6 h-1 rounded" style={{backgroundColor:'#a881ff'}} /><span>Granted / Grants</span></div><div className="flex items-center gap-2 rounded px-2 py-1"><span className="inline-block w-6 h-1 rounded" style={{backgroundColor:'#9aa4b3'}} /><span>Other</span></div></div></div>
              <div><p className="text-[11px] uppercase tracking-[0.24em] text-premium-muted-dim">Selection</p><div className="mt-3 rounded-lg border border-premium-border/50 bg-premium-surface/90 p-3 text-xs text-premium-text-secondary">{hoverNode ? <div className="space-y-1"><p className="font-semibold text-premium-text">{hoverNode.fullLabel || hoverNode.label}</p><p className="text-[10px] uppercase tracking-wide text-premium-muted-dim">{hoverNode.nodeType}</p><p className="font-mono text-[10px] text-premium-muted">{hoverNode.id}</p>{hoverNode.properties?.validation ? <p className="text-premium-muted">Status: {String(hoverNode.properties.validation)}</p> : null}</div> : 'Hover nodes to preview, click to lock focus.'}</div></div>
                </div>
              </div>
            </div>
          </div>
        )}

        {isOpsChrome && selectedNode && (
          <div className="pointer-events-none absolute bottom-3 left-3 z-30 max-w-[min(280px,calc(100%-1.5rem))]">
            <div className={`pointer-events-auto rounded-lg border p-3 text-xs backdrop-blur-xl ${isLightMode ? 'border-slate-300/60 bg-slate-100/90 text-slate-700' : 'border-premium-border/55 bg-premium-card/95 text-premium-text-secondary'}`}>
              <p className={`text-sm font-semibold ${isLightMode ? 'text-slate-900' : 'text-premium-text'}`}>{selectedNode.fullLabel}</p>
              <p className={`mt-0.5 text-[11px] capitalize ${isLightMode ? 'text-premium-muted-dim' : 'text-premium-muted'}`}>{selectedNode.nodeType || selectedNode.category}</p>
              <p className={`mt-2 font-mono text-[10px] break-all ${isLightMode ? 'text-premium-muted-dim' : 'text-premium-muted'}`}>{selectedNode.id}</p>
              <p className="mt-1.5">Validation: {String(selectedNode.properties.validation ?? 'APPROVED')}</p>
              <p className="mt-1">Connected: {selectedNode.properties.connected === false ? 'no' : 'yes'}</p>
              <p className="mt-1">On trace: {selectedNode.properties.traced ? 'yes' : 'no'}</p>
            </div>
          </div>
        )}

        {/* Context menu for admin IAM actions */}
        {contextMenu.visible && contextMenu.node && isAdmin && !isOpsChrome && (
          <div
            className="absolute z-50 rounded-lg border border-premium-border/55 bg-premium-card/98 shadow-2xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setContextMenu({ visible: false, x: 0, y: 0, node: null })}
          >
            <div className="py-1 min-w-[200px]">
              <div className="px-3 py-1.5 text-xs font-semibold text-premium-muted uppercase tracking-wide">
                Admin Actions
              </div>
              <div className="border-t border-premium-border/50" />
              {onRequestAiAssist && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (contextMenu.node) {
                      requestAiAssist(contextMenu.node);
                    }
                  }}
                  className="w-full px-3 py-2 text-left text-sm text-sky-300 hover:bg-sky-950/20 transition"
                >
                  Ask AI About This Node
                </button>
              )}
              {contextMenu.node && (
                <div className="px-3 py-2 text-xs text-premium-muted-dim flex items-center gap-2">
                  <Lock className="w-3 h-3" />
                  Grid remediation actions coming soon
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default GiopGraphCanvas;