import { useCallback, useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { GiopGraphCanvas } from './GiopGraphCanvas';
import { GiopLineageTimeline } from './GiopLineageTimeline';
import { GIOP_GRAPH_QUERY_OPTIONS, type GiopGraphQueryKey } from '../lib/giopGraphTypes';
import type { PortalGraphResponse } from '../lib/giopGraphTypes';
import { mockNodeAssist, mockGraphAssist } from '../lib/giopAiStub';

interface GraphAiMessage {
  role: 'user' | 'assistant';
  content: string;
  findings?: string[];
  actions?: string[];
}

interface GiopTopologyTabProps {
  graph: PortalGraphResponse | null;
  loading: boolean;
  revalidating?: boolean;
  error: string | null;
  graphQuery: GiopGraphQueryKey;
  onQueryChange: (key: GiopGraphQueryKey) => void;
  isLightMode: boolean;
  focusMrid?: string | null;
  onFocusHandled?: () => void;
  onNodeSelect?: (mrid: string, label?: string) => void;
  compact?: boolean;
  graphQueryOptions?: typeof GIOP_GRAPH_QUERY_OPTIONS;
}

export function GiopTopologyTab({
  graph,
  loading,
  revalidating = false,
  error,
  graphQuery,
  onQueryChange,
  isLightMode,
  focusMrid,
  onFocusHandled,
  onNodeSelect,
  compact = false,
  graphQueryOptions = GIOP_GRAPH_QUERY_OPTIONS,
}: GiopTopologyTabProps) {
  const [graphAiOpen, setGraphAiOpen] = useState(false);
  const [graphAiNodeId, setGraphAiNodeId] = useState<string | null>(null);
  const [graphAiNodeTitle, setGraphAiNodeTitle] = useState('');
  const [graphAiDraft, setGraphAiDraft] = useState('');
  const [graphAiLoading, setGraphAiLoading] = useState(false);
  const [graphAiMessages, setGraphAiMessages] = useState<GraphAiMessage[]>([]);
  const [appliedProposalIds] = useState(() => new Set<string>());

  const handleGraphAiAssist = useCallback(
    (request: { nodeId: string; nodeTitle: string; prompt: string }) => {
      setGraphAiOpen(true);
      setGraphAiNodeId(request.nodeId);
      setGraphAiNodeTitle(request.nodeTitle);
      setGraphAiDraft(request.prompt);
      const node = graph?.nodes.find((n) => n.id === request.nodeId);
      const props = (node?.properties || {}) as Record<string, unknown>;
      void mockNodeAssist({
        mrid: request.nodeId,
        name: request.nodeTitle,
        validation: String(props.validation || 'APPROVED'),
        connected: props.connected !== false,
        traced: props.traced === true,
      }).then((response) => {
        setGraphAiMessages([
          { role: 'user', content: request.prompt },
          {
            role: 'assistant',
            content: response.content,
            findings: response.findings,
            actions: response.actions,
          },
        ]);
      });
    },
    [graph],
  );

  const submitGraphAiPrompt = useCallback(async () => {
    if (!graphAiDraft.trim()) return;
    setGraphAiLoading(true);
    const userMsg = graphAiDraft.trim();
    setGraphAiDraft('');
    setGraphAiMessages((prev) => [...prev, { role: 'user', content: userMsg }]);
    const response = graphAiNodeId
      ? await mockNodeAssist({
          mrid: graphAiNodeId,
          name: graphAiNodeTitle,
          validation: 'APPROVED',
          connected: true,
          traced: true,
        })
      : await mockGraphAssist(userMsg, graph?.metrics?.total_nodes ?? 0);
    setGraphAiMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: response.content,
        findings: response.findings,
        actions: response.actions,
      },
    ]);
    setGraphAiLoading(false);
  }, [graph?.metrics?.total_nodes, graphAiDraft, graphAiNodeId, graphAiNodeTitle]);

  useEffect(() => {
    if (!graphAiOpen) {
      setGraphAiMessages([]);
    }
  }, [graphAiOpen]);

  return (
    <div className={`flex flex-col h-full min-h-0 ${compact ? '' : 'p-4'}`}>
      <div className={`shrink-0 mb-3 flex flex-wrap items-center justify-center gap-2 ${compact ? 'px-2 pt-2' : ''}`}>
        {graphQueryOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onQueryChange(option.key)}
            className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-all ${
              graphQuery === option.key
                ? 'border-sky-500/70 bg-sky-500/22 text-sky-100'
                : 'border-slate-700/80 bg-slate-900/80 text-slate-300 hover:border-slate-500 hover:bg-slate-800/85'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 mx-4 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {graph?.metrics?.note && !loading && (
        <div
          className={`mb-3 mx-4 rounded-lg border px-4 py-2 text-xs ${
            isLightMode
              ? 'border-amber-300 bg-amber-50 text-amber-900'
              : 'border-amber-500/40 bg-amber-950/40 text-amber-100'
          }`}
        >
          {graph.metrics.note}
        </div>
      )}

      {revalidating && graph && !loading && (
        <p className={`mb-2 mx-4 text-center text-[10px] ${isLightMode ? 'text-slate-400' : 'text-slate-500'}`}>
          Updating topology…
        </p>
      )}

      {loading && (
        <div className="flex-1 flex flex-col items-center justify-center py-20">
          <Clock className="mb-4 h-12 w-12 animate-spin text-[#7e8fae]" />
          <p className="text-slate-400">Loading network topology...</p>
        </div>
      )}

      {graph && !loading && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0">
            <GiopGraphCanvas
            graph={graph}
            isAdmin
            isLightMode={isLightMode}
            focusNodeArn={focusMrid || undefined}
            onFocusNodeHandled={onFocusHandled}
            onNodeSelect={onNodeSelect}
            onRequestAiAssist={handleGraphAiAssist}
            onRequestGraphAiMode={() => setGraphAiOpen(true)}
            aiAssist={{
              isOpen: graphAiOpen,
              mode: graphAiNodeId ? 'node' : 'graph',
              nodeId: graphAiNodeId,
              nodeTitle: graphAiNodeTitle,
              draft: graphAiDraft,
              loading: graphAiLoading,
              messages: graphAiMessages,
              appliedProposalIds,
              canApplyProposals: false,
              onDraftChange: setGraphAiDraft,
              onSubmit: submitGraphAiPrompt,
              onClose: () => setGraphAiOpen(false),
              onApplyProposal: () => {},
            }}
          />
          </div>
          {!compact && focusMrid && (
            <div className="shrink-0 px-4 pb-2">
              <GiopLineageTimeline assetMrid={focusMrid} isLightMode={isLightMode} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
