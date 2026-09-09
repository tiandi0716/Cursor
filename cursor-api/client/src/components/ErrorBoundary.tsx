import { Component, type ErrorInfo, type ReactNode } from "react";

type Reset = () => void;

type Props = {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: Reset) => ReactNode);
  onReset?: () => void;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui]", error, info.componentStack);
  }

  reset = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback(this.state.error, this.reset);
    if (fallback) return fallback;
    return (
      <div className="crash">
        <h1>界面出错了</h1>
        <pre>{this.state.error.stack || this.state.error.message}</pre>
        <button type="button" className="btn primary" onClick={this.reset}>
          重试
        </button>
      </div>
    );
  }
}
