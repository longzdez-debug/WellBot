import { randomUUID } from 'node:crypto';

type MetricValue = number | string;

function labelEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export class Observability {
  readonly serviceName = 'wellbot';
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();

  inc(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) || 0) + value);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, Number.isFinite(value) ? value : 0);
  }

  traceId(): string {
    return randomUUID().replace(/-/g, '');
  }

  prometheus(extra: Record<string, MetricValue> = {}): string {
    const lines: string[] = [
      '# HELP wellbot_info WellBOT service information.',
      '# TYPE wellbot_info gauge',
      'wellbot_info{service="wellbot"} 1',
    ];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE wellbot_${name} counter`);
      lines.push(`wellbot_${name} ${value}`);
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# TYPE wellbot_${name} gauge`);
      lines.push(`wellbot_${name} ${value}`);
    }
    for (const [name, value] of Object.entries(extra)) {
      const safeName = name.replace(/[^a-zA-Z0-9_]/g, '_');
      if (typeof value === 'number' && Number.isFinite(value)) {
        lines.push(`wellbot_${safeName} ${value}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  labels(values: Record<string, string>): string {
    return Object.entries(values)
      .map(([key, value]) => `${key}="${labelEscape(value)}"`)
      .join(',');
  }
}

export const observability = new Observability();
