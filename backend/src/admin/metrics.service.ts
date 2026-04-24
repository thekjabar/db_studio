import { Injectable } from '@nestjs/common';

/**
 * In-process metric counters + histograms, rendered in Prometheus text
 * exposition format.
 *
 * Chose a hand-rolled implementation over `prom-client` because:
 *   - The metric surface is small and stable.
 *   - Avoids a dep that adds ~500KB to the bundle for a feature used by
 *     one endpoint.
 *   - Keeps label-set control explicit — we'd otherwise easily blow up
 *     cardinality (e.g. per-URL counters).
 *
 * If the surface grows (per-route histograms, per-connection gauges,
 * driver-level counters), swap this for prom-client and keep the public
 * observe/inc/setGauge surface.
 */
@Injectable()
export class MetricsService {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  // Histogram: bucket upper-bound (ms) → cumulative count. Fixed buckets
  // tuned for web-request latency. Anything >10s goes into +Inf.
  private static readonly BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];
  private histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();

  private labelKey(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}="${labels[k].replace(/"/g, '\\"')}"`)
      .join(',');
    return `${name}{${parts}}`;
  }

  inc(name: string, labels?: Record<string, string>, by = 1): void {
    const key = this.labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(this.labelKey(name, labels), value);
  }

  observeMs(name: string, valueMs: number, labels?: Record<string, string>): void {
    const key = this.labelKey(name, labels);
    let h = this.histograms.get(key);
    if (!h) {
      h = { buckets: new Array(MetricsService.BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, h);
    }
    h.sum += valueMs;
    h.count += 1;
    for (let i = 0; i < MetricsService.BUCKETS_MS.length; i++) {
      if (valueMs <= MetricsService.BUCKETS_MS[i]) h.buckets[i] += 1;
    }
  }

  /** Emit Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    // Counters
    const counterFamilies = groupByMetricName(this.counters);
    for (const [name, entries] of counterFamilies) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of entries) lines.push(`${key} ${value}`);
    }

    // Gauges
    const gaugeFamilies = groupByMetricName(this.gauges);
    for (const [name, entries] of gaugeFamilies) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [key, value] of entries) lines.push(`${key} ${value}`);
    }

    // Histograms
    const histFamilies = groupByMetricName(this.histograms);
    for (const [name, entries] of histFamilies) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, h] of entries) {
        const parsed = parseLabelKey(key);
        const extraLabels = parsed.labels;
        const base = parsed.name;
        for (let i = 0; i < MetricsService.BUCKETS_MS.length; i++) {
          lines.push(
            renderWithExtra(`${base}_bucket`, extraLabels, { le: String(MetricsService.BUCKETS_MS[i]) }) +
              ` ${h.buckets[i]}`,
          );
        }
        lines.push(
          renderWithExtra(`${base}_bucket`, extraLabels, { le: '+Inf' }) + ` ${h.count}`,
        );
        lines.push(renderWithExtra(`${base}_sum`, extraLabels) + ` ${h.sum}`);
        lines.push(renderWithExtra(`${base}_count`, extraLabels) + ` ${h.count}`);
      }
    }

    return lines.join('\n') + '\n';
  }
}

function groupByMetricName<V>(m: Map<string, V>): Map<string, [string, V][]> {
  const out = new Map<string, [string, V][]>();
  for (const [k, v] of m) {
    const name = k.includes('{') ? k.slice(0, k.indexOf('{')) : k;
    const list = out.get(name) ?? [];
    list.push([k, v]);
    out.set(name, list);
  }
  return out;
}

function parseLabelKey(key: string): { name: string; labels: Record<string, string> } {
  const brace = key.indexOf('{');
  if (brace < 0) return { name: key, labels: {} };
  const name = key.slice(0, brace);
  const inside = key.slice(brace + 1, key.lastIndexOf('}'));
  const labels: Record<string, string> = {};
  // Cheap label parse — we produced these, so no exotic escaping to handle.
  for (const pair of inside.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim().replace(/^"|"$/g, '');
    labels[k] = v;
  }
  return { name, labels };
}

function renderWithExtra(
  name: string,
  labels: Record<string, string>,
  extra?: Record<string, string>,
): string {
  const merged = { ...labels, ...(extra ?? {}) };
  const keys = Object.keys(merged);
  if (keys.length === 0) return name;
  const parts = keys.sort().map((k) => `${k}="${merged[k].replace(/"/g, '\\"')}"`);
  return `${name}{${parts.join(',')}}`;
}
