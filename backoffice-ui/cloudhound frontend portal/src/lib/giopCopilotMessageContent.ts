/** Structured network summary from copilot fast path / spatial tools. */
export interface CopilotNetworkSummaryStructured {
  type: 'network_summary';
  place_label: string;
  electrical_assets_total: number;
  point_assets_total?: number;
  nodes_total: number;
  lines_total: number;
  node_rows: Array<{ key: string; label: string; count: number }>;
  line_rows: Array<{ key: string; label: string; count: number }>;
}

export type CopilotStructuredContent = CopilotNetworkSummaryStructured;

export interface CopilotProgressStep {
  label: string;
  detail?: string | null;
  status?: string;
  ts?: number;
}

/** Fallback steps while waiting for server progress (Cursor-style). */
export function inferCopilotThinkingSteps(query: string): string[] {
  const q = query.toLowerCase();
  const steps = ['Understanding your question'];
  if (/(how many|count|number of)/.test(q)) {
    steps.push('Matching count request', 'Querying asset inventory');
  } else if (/(asset|network|electrical|pole|transformer)/.test(q)) {
    steps.push('Matching spatial request', 'Summarizing network inventory');
  } else if (/(staging|capture)/.test(q)) {
    steps.push('Loading staging context');
  } else if (/(work order)/.test(q)) {
    steps.push('Searching work orders in view');
  } else if (/(highlight|pan|zoom|map)/.test(q)) {
    steps.push('Resolving place on map');
  } else {
    steps.push('Planning tool calls', 'Consulting steward assistant');
  }
  steps.push('Preparing reply');
  return steps;
}

/** Parse simple steward-formatted text blocks into sections. */
export function parseCopilotTextSections(content: string): Array<{
  title?: string;
  lines: string[];
}> {
  const raw = content.trim();
  if (!raw) return [];

  const blocks = raw.split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const first = lines[0] ?? '';
    const isTitle = first.includes('—') || /^[A-Z].*assets/i.test(first);
    if (isTitle && lines.length > 1) {
      return { title: first.replace(/\*\*/g, ''), lines: lines.slice(1) };
    }
    if (isTitle && lines.length === 1) {
      return { title: first.replace(/\*\*/g, ''), lines: [] };
    }
    return { lines };
  });
}

export function stripMarkdownInline(text: string): string {
  return text.replace(/\*\*/g, '').replace(/^•\s*/, '').trim();
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
