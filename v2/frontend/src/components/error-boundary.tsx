import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: React.ReactNode;
  /** Shown at the top of the fallback UI. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. Prevents a render error anywhere in the tree from
 * leaving the user with a blank screen. Shows the error message, a stack trace
 * (collapsed), and actions to retry / reload.
 *
 * Only catches React render errors — async errors surface via react-query / axios
 * and are handled elsewhere.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });
  private reload = () => window.location.reload();

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-lg w-full rounded-lg border border-border bg-card shadow-xl p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 rounded-full bg-destructive/15 border border-destructive/30 flex items-center justify-center shrink-0">
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold">Something went wrong</h2>
              <p className="text-xs text-muted-foreground">
                {this.props.label ?? "An unexpected error broke this view."} You can try again, or reload the app.
              </p>
            </div>
          </div>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-mono break-words">
            {error.message || "Unknown error"}
          </div>
          {error.stack && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">
                Show technical details
              </summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
                {error.stack}
              </pre>
            </details>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={this.reset}>
              Try again
            </Button>
            <Button size="sm" onClick={this.reload}>
              <RefreshCw className="h-3.5 w-3.5" /> Reload
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
