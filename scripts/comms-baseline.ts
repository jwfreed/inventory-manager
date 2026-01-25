import readline from 'readline';

type LogEntry = {
  event?: string;
  path?: string;
  bytesIn?: number;
  bytesOut?: number;
  durationMs?: number;
};

type Bucket = {
  count: number;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
};

const buckets: Record<string, Bucket> = {
  receiving: { count: 0, bytesIn: 0, bytesOut: 0, durationMs: 0 },
  inventory_lookup: { count: 0, bytesIn: 0, bytesOut: 0, durationMs: 0 },
  ship_pick: { count: 0, bytesIn: 0, bytesOut: 0, durationMs: 0 },
  other: { count: 0, bytesIn: 0, bytesOut: 0, durationMs: 0 }
};

function categorize(pathname = ''): keyof typeof buckets {
  if (
    pathname.startsWith('/purchase-orders') ||
    pathname.startsWith('/purchase-order-receipts') ||
    pathname.startsWith('/receipts') ||
    pathname.startsWith('/qc') ||
    pathname.startsWith('/putaways') ||
    pathname.startsWith('/closeout')
  ) {
    return 'receiving';
  }
  if (
    pathname.startsWith('/inventory-snapshot') ||
    pathname.startsWith('/inventory-summary') ||
    pathname.startsWith('/inventory-movements') ||
    pathname.startsWith('/atp')
  ) {
    return 'inventory_lookup';
  }
  if (
    pathname.startsWith('/picking') ||
    pathname.startsWith('/shipments') ||
    pathname.startsWith('/shipping-containers') ||
    pathname.startsWith('/reservations')
  ) {
    return 'ship_pick';
  }
  return 'other';
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  try {
    const entry = JSON.parse(line) as LogEntry;
    if (entry.event !== 'http_request') return;
    const bucket = buckets[categorize(entry.path)];
    bucket.count += 1;
    bucket.bytesIn += entry.bytesIn ?? 0;
    bucket.bytesOut += entry.bytesOut ?? 0;
    bucket.durationMs += entry.durationMs ?? 0;
  } catch {
    // Ignore non-JSON lines
  }
});

rl.on('close', () => {
  const summary = Object.entries(buckets).map(([name, bucket]) => ({
    name,
    count: bucket.count,
    bytesIn: bucket.bytesIn,
    bytesOut: bucket.bytesOut,
    avgDurationMs: bucket.count ? Math.round(bucket.durationMs / bucket.count) : 0
  }));

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 2));
});
