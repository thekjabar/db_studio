import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Apple,
  Database,
  Download,
  MonitorDown,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AGENT_DOWNLOADS } from "@/lib/api";

type PlatformKey = "windows" | "macArm" | "macIntel" | "linux";

interface Platform {
  key: PlatformKey;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Family used for OS detection + grouping the "needs chmod / gatekeeper" hint. */
  family: "windows" | "mac" | "linux";
  /** macOS builds aren't shipped yet (the tray backend needs a Mac to compile),
   *  so they render as a disabled "coming soon" row rather than a dead link. */
  available: boolean;
}

const PLATFORMS: Record<PlatformKey, Platform> = {
  windows: {
    key: "windows",
    label: "Windows",
    href: AGENT_DOWNLOADS.windows,
    icon: MonitorDown,
    family: "windows",
    available: true,
  },
  macArm: {
    key: "macArm",
    label: "macOS (Apple Silicon)",
    href: AGENT_DOWNLOADS.macArm,
    icon: Apple,
    family: "mac",
    available: false,
  },
  macIntel: {
    key: "macIntel",
    label: "macOS (Intel)",
    href: AGENT_DOWNLOADS.macIntel,
    icon: Apple,
    family: "mac",
    available: false,
  },
  linux: {
    key: "linux",
    label: "Linux (x64)",
    href: AGENT_DOWNLOADS.linux,
    icon: Terminal,
    family: "linux",
    available: true,
  },
};

/** Best-effort OS detection from the browser. We can't tell Intel vs Apple
 *  Silicon apart from JS, so macOS defaults to the arm64 build (all new Macs)
 *  and both mac options stay visible in the list below. */
function detectPrimary(): PlatformKey {
  if (typeof navigator === "undefined") return "windows";
  const ua = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (ua.includes("win")) return "windows";
  // macOS builds aren't available yet — Mac visitors get Linux? No: default the
  // big button to Windows and surface the "macOS coming soon" note. (A Mac user
  // still sees the disabled mac rows below.)
  if (ua.includes("linux") || ua.includes("android") || ua.includes("x11")) return "linux";
  return "windows";
}

function PlatformRow({ platform }: { platform: Platform }) {
  const Icon = platform.icon;
  if (!platform.available) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border bg-background/30 px-3 py-2.5 opacity-60"
        title="Coming soon"
      >
        <span className="flex items-center gap-2.5 text-sm font-medium">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {platform.label}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">Coming soon</span>
      </div>
    );
  }
  return (
    <a
      href={platform.href}
      download
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2.5 hover:bg-accent hover:text-accent-foreground transition-colors"
    >
      <span className="flex items-center gap-2.5 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {platform.label}
      </span>
      <Download className="h-4 w-4 text-muted-foreground shrink-0" />
    </a>
  );
}

export default function DownloadPage() {
  const primaryKey = useMemo(detectPrimary, []);
  const primary = PLATFORMS[primaryKey];

  // Everything except the big primary button, in a stable order.
  const others = (["windows", "macArm", "macIntel", "linux"] as PlatformKey[])
    .filter((k) => k !== primaryKey)
    .map((k) => PLATFORMS[k]);

  return (
    <div className="min-h-screen flex items-center justify-center gradient-bg p-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <Link
            to="/"
            aria-label="Query Schema home"
            className="h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3 hover:bg-primary/20 transition-colors"
          >
            <Database className="h-6 w-6 text-primary" />
          </Link>
          <h1 className="text-xl font-semibold text-center">Download the DB Studio agent</h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">
            A small helper that lets DB Studio reach databases inside your own network.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card shadow-xl p-6 space-y-6">
          {/* Primary, OS-detected download */}
          <div className="space-y-2">
            <Button asChild size="lg" className="w-full">
              <a href={primary.href} download>
                <Download className="h-4 w-4" />
                Download for {primary.label}
              </a>
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              Detected your system automatically. Not right? Pick another below.
            </p>
          </div>

          {/* Other platforms */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Other platforms
            </div>
            <div className="space-y-2">
              {others.map((p) => (
                <PlatformRow key={p.key} platform={p} />
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
              On macOS or Linux, make the file executable with{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">chmod +x</code> after
              downloading. macOS may block it the first time — right-click the file and choose{" "}
              <span className="font-medium text-foreground">Open</span> to get past Gatekeeper.
            </p>
          </div>

          {/* How to use */}
          <div className="space-y-3 border-t border-border pt-5">
            <div className="text-sm font-medium">How to use it</div>
            <ol className="space-y-2.5 text-xs text-muted-foreground">
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary text-[11px] font-semibold">
                  1
                </span>
                <span>
                  Download and run the agent on a computer that can reach your database's
                  network.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary text-[11px] font-semibold">
                  2
                </span>
                <span>
                  Your browser opens automatically — click{" "}
                  <span className="font-medium text-foreground">Allow</span> to authorize it.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary text-[11px] font-semibold">
                  3
                </span>
                <span>
                  Back in DB Studio, your connection now routes securely through the agent.
                </span>
              </li>
            </ol>
          </div>

          {/* First-run / unsigned-binary reassurance */}
          <div className="rounded-md border border-border bg-muted/40 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-primary" />
              First time you run it
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              The agent isn't code-signed yet, so your OS may warn that it's from an unknown
              developer. This is expected for any brand-new app — the agent is safe: it only
              connects out to DB Studio and never accepts inbound connections.
            </p>
            <div className="space-y-3 text-[11px] text-muted-foreground leading-relaxed">
              <div className="flex gap-2.5">
                <MonitorDown className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                <div>
                  <div className="font-medium text-foreground">Windows</div>
                  Windows may show a blue{" "}
                  <span className="font-medium text-foreground">"Windows protected your PC"</span>{" "}
                  screen. Click{" "}
                  <span className="font-medium text-foreground">More info</span> →{" "}
                  <span className="font-medium text-foreground">Run anyway</span>.
                </div>
              </div>
              <div className="flex gap-2.5">
                <Apple className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                <div>
                  <div className="font-medium text-foreground">macOS</div>
                  macOS may say the app{" "}
                  <span className="italic">
                    "cannot be opened because it is from an unidentified developer."
                  </span>{" "}
                  Right-click (or Control-click) the file →{" "}
                  <span className="font-medium text-foreground">Open</span> →{" "}
                  <span className="font-medium text-foreground">Open</span>. Or run{" "}
                  <code className="rounded bg-background border border-border px-1 py-0.5 font-mono">
                    chmod +x agent-macos-*
                  </code>{" "}
                  first in Terminal.
                </div>
              </div>
              <div className="flex gap-2.5">
                <Terminal className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                <div>
                  <div className="font-medium text-foreground">Linux</div>
                  Make it executable:{" "}
                  <code className="rounded bg-background border border-border px-1 py-0.5 font-mono">
                    chmod +x agent-linux-amd64
                  </code>
                  , then run{" "}
                  <code className="rounded bg-background border border-border px-1 py-0.5 font-mono">
                    ./agent-linux-amd64
                  </code>
                  .
                </div>
              </div>
            </div>
          </div>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-4">
          <Link to="/" className="text-primary hover:underline">
            Back to DB Studio
          </Link>
        </p>
      </div>
    </div>
  );
}
