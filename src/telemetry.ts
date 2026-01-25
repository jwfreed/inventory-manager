import process from 'node:process';

if (process.env.OTEL_ENABLED !== 'true' && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // Telemetry disabled by default; enable via OTEL_ENABLED=true or OTEL_EXPORTER_OTLP_ENDPOINT.
} else {
  // Lazy import to avoid hard dependency at runtime when disabled.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  (async () => {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = await import('@opentelemetry/resources');
    const { SemanticResourceAttributes } = await import('@opentelemetry/semantic-conventions');

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    });

    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'inventory-manager-api',
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development'
    });

    const sdk = new NodeSDK({
      resource,
      traceExporter: exporter,
      instrumentations: [getNodeAutoInstrumentations()]
    });

    await sdk.start();

    const shutdown = async () => {
      await sdk.shutdown();
    };

    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
  })();
}
