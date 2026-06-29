import { Component, type ErrorInfo, type ReactNode } from 'react';

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
    console.error('[GiopMap] render error:', error, info.componentStack);
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
      : 'border-slate-700 bg-slate-900/60 text-slate-200';

    return (
      <div className={`m-3 rounded-lg border p-4 text-sm ${card}`}>
        <p className="font-medium">Map preview failed to load</p>
        <p className={`mt-1 text-xs ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>
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
