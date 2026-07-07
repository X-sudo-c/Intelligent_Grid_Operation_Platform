import { motion } from 'framer-motion';
import { Check, Loader2 } from 'lucide-react';
import { useCopilotThinkingProgress } from '../hooks/useCopilotThinkingProgress';
import {
  formatCount,
  inferCopilotThinkingSteps,
  parseCopilotTextSections,
  stripMarkdownInline,
  type CopilotNetworkSummaryStructured,
  type CopilotStructuredContent,
} from '../lib/giopCopilotMessageContent';

interface CopilotNetworkSummaryCardProps {
  data: CopilotNetworkSummaryStructured;
  isLightMode: boolean;
}

function StatRow({
  label,
  count,
  isLightMode,
}: {
  label: string;
  count: number;
  isLightMode: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 ${
        isLightMode ? 'bg-white/80' : 'bg-black/20'
      }`}
    >
      <span className={isLightMode ? 'text-slate-600' : 'text-slate-300'}>{label}</span>
      <span className={`font-semibold tabular-nums ${isLightMode ? 'text-slate-900' : 'text-white'}`}>
        {formatCount(count)}
      </span>
    </div>
  );
}

export function CopilotNetworkSummaryCard({ data, isLightMode }: CopilotNetworkSummaryCardProps) {
  const title = data.place_label;
  return (
    <div className="space-y-3">
      <div>
        <p className={`text-xs uppercase tracking-wide font-medium ${isLightMode ? 'text-indigo-600' : 'text-indigo-300'}`}>
          Electrical assets
        </p>
        <p className={`font-semibold ${isLightMode ? 'text-slate-900' : 'text-white'}`}>{title}</p>
        <p className={`text-xs mt-1 ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>
          {formatCount(data.electrical_assets_total)} total · {formatCount(data.nodes_total)} nodes ·{' '}
          {formatCount(data.lines_total)} lines
        </p>
      </div>

      {data.node_rows.length > 0 && (
        <div className="space-y-1.5">
          <p className={`text-xs font-medium ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>Point assets</p>
          {data.node_rows.map((row) => (
            <StatRow key={row.key} label={row.label} count={row.count} isLightMode={isLightMode} />
          ))}
        </div>
      )}

      {data.line_rows.length > 0 && (
        <div className="space-y-1.5">
          <p className={`text-xs font-medium ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>Lines by voltage</p>
          {data.line_rows.map((row) => (
            <StatRow key={row.key} label={row.label} count={row.count} isLightMode={isLightMode} />
          ))}
        </div>
      )}
    </div>
  );
}

interface CopilotMessageBodyProps {
  content: string;
  structured?: CopilotStructuredContent | null;
  isLightMode: boolean;
}

export function CopilotMessageBody({ content, structured, isLightMode }: CopilotMessageBodyProps) {
  if (structured?.type === 'network_summary') {
    return <CopilotNetworkSummaryCard data={structured} isLightMode={isLightMode} />;
  }

  const sections = parseCopilotTextSections(content);
  if (sections.length === 0) {
    return <p>{content}</p>;
  }

  return (
    <div className="space-y-3">
      {sections.map((section, idx) => (
        <div key={idx}>
          {section.title && (
            <p className={`font-semibold mb-1.5 ${isLightMode ? 'text-slate-900' : 'text-white'}`}>
              {section.title}
            </p>
          )}
          <div className="space-y-1">
            {section.lines.map((line, lineIdx) => {
              const clean = stripMarkdownInline(line);
              const countMatch = clean.match(/^([\d,]+)\s+(.+)$/);
              if (countMatch) {
                const count = Number(countMatch[1].replace(/,/g, ''));
                const label = countMatch[2];
                if (!Number.isNaN(count)) {
                  return <StatRow key={lineIdx} label={label} count={count} isLightMode={isLightMode} />;
                }
              }
              return (
                <p key={lineIdx} className={isLightMode ? 'text-slate-700' : 'text-slate-200'}>
                  {clean}
                </p>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

interface CopilotThinkingStatusProps {
  query: string;
  steps: string[];
  activeIndex: number;
  isLightMode: boolean;
}

export function CopilotThinkingStatus({
  query,
  steps,
  activeIndex,
  isLightMode,
}: CopilotThinkingStatusProps) {
  const preview = query.length > 72 ? `${query.slice(0, 69)}…` : query;

  return (
    <div className="space-y-3 min-w-[200px]">
      <div>
        <p className={`text-xs font-medium ${isLightMode ? 'text-indigo-600' : 'text-indigo-300'}`}>
          Working on it
        </p>
        <p className={`text-xs mt-0.5 line-clamp-2 ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>
          “{preview}”
        </p>
      </div>
      <ul className="space-y-2">
        {steps.map((step, idx) => {
          const done = idx < activeIndex;
          const active = idx === activeIndex;
          return (
            <motion.li
              key={`${step}-${idx}`}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.04 }}
              className={`flex items-start gap-2 text-xs ${
                done
                  ? isLightMode
                    ? 'text-slate-500'
                    : 'text-slate-400'
                  : active
                    ? isLightMode
                      ? 'text-slate-800'
                      : 'text-slate-100'
                    : isLightMode
                      ? 'text-slate-400'
                      : 'text-slate-500'
              }`}
            >
              <span className="mt-0.5 shrink-0">
                {done ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
                ) : (
                  <span className="inline-block h-3.5 w-3.5 rounded-full border border-current opacity-40" />
                )}
              </span>
              <span>{step}</span>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}

export function CopilotPendingBubble({
  query,
  requestId,
  isLightMode,
}: {
  query: string;
  requestId?: string;
  isLightMode: boolean;
}) {
  const { steps, activeIndex } = useCopilotThinkingProgress(requestId, query, true);
  return <CopilotThinkingStatus query={query} steps={steps} activeIndex={activeIndex} isLightMode={isLightMode} />;
}

export function buildThinkingSteps(
  query: string,
  serverSteps: Array<{ label: string; status?: string }>,
): { steps: string[]; activeIndex: number } {
  if (serverSteps.length > 0) {
    const steps = serverSteps.map((s) => s.label);
    const lastDone = [...serverSteps].reverse().findIndex((s) => s.status === 'done');
    const activeIndex =
      lastDone >= 0 ? Math.max(0, serverSteps.length - 1 - lastDone) : Math.max(0, steps.length - 1);
    return { steps, activeIndex: Math.min(activeIndex, steps.length - 1) };
  }
  const fallback = inferCopilotThinkingSteps(query);
  return { steps: fallback, activeIndex: 0 };
}
