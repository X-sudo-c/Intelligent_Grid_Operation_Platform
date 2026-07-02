import { Component, type ErrorInfo, type ReactNode } from 'react';
import { giopLog } from '../lib/giopDebugLog';

interface GiopMapErrorBoundaryProps {
  children: ReactNode;
  isLightMode?: boolean;
  onReset?: () => void;
}

interface GiopMapErrorBoundaryState {
  error: Error | null;
}

export class GiopMapErrorBoundary extends Component<
  GiopMapErrorBoundaryProps,
  GiopMapErrorBoundaryState
> {
  state: GiopMapErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): GiopMapErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    giopLog.map.error('render error', { error, componentStack: info.componentStack });
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { isLightMode = false } = this.props;
    const card = isLightMode
      ? 'border-slate-200 bg-white text-slate-800'
      : 'border-premium-border/70 bg-premium-surface/90 text-slate-200';

    return (
      <div className={`m-3 rounded-lg border p-4 text-sm ${card}`}>
        <p className="font-medium">Map preview failed to load</p>
        <p className={`mt-1 text-xs ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>
          {error.message || 'Unexpected map error'}
        </p>
        <button
          type="button"
          onClick={this.handleReset}
          className="mt-3 rounded bg-cyan-700 px-3 py-1.5 text-xs text-white hover:bg-cyan-600"
        >
          Retry map
        </button>
      </div>
    );
  }
}
