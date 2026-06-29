/**
 * GIOP steward assistant — calls sync-service when available, local fallback otherwise.
 */

import { portalAiChat } from '../api/giop-api';

export interface GiopNodeContext {
  mrid: string;
  name: string;
  validation: string;
  connected: boolean;
  traced?: boolean;
}

export async function mockNodeAssist(ctx: GiopNodeContext): Promise<{
  content: string;
  findings: string[];
  actions: string[];
}> {
  try {
    const resp = await portalAiChat({
      message: `Explain asset ${ctx.name} (${ctx.mrid}). Validation: ${ctx.validation}. Connected: ${ctx.connected}.`,
      mrid: ctx.mrid,
      context: { validation: ctx.validation, connected: ctx.connected, traced: ctx.traced },
    });
    return {
      content: resp.content,
      findings: resp.findings ?? [],
      actions: resp.actions ?? [],
    };
  } catch {
    const findings: string[] = [];
    if (!ctx.connected) findings.push('Asset is not connected to the network graph.');
    if (ctx.validation === 'IN_CONFLICT') {
      findings.push('Validation state is IN_CONFLICT — field capture disagrees with master.');
    }
    return {
      content: `**${ctx.name}** (${ctx.mrid})\n\nValidation: \`${ctx.validation}\` · Connected: ${ctx.connected ? 'yes' : 'no'}.`,
      findings: findings.length ? findings : ['No anomalies detected for this asset in the current view.'],
      actions: ['Review staging queue', 'Run topology repair', 'Approve field capture after verification'],
    };
  }
}

export async function mockGraphAssist(
  prompt: string,
  nodeCount: number,
): Promise<{ content: string; findings: string[]; actions: string[] }> {
  try {
    const resp = await portalAiChat({
      message: prompt,
      context: { node_count: nodeCount },
    });
    return {
      content: resp.content,
      findings: resp.findings ?? [],
      actions: resp.actions ?? [],
    };
  } catch {
    return {
      content: `Received: "${prompt}"\n\nThe graph shows **${nodeCount}** connectivity nodes.`,
      findings: ['Graph data is sourced from GET /api/v1/trace.'],
      actions: ['Use query chips to filter traced, disconnected, or conflict assets.'],
    };
  }
}
