# Lambda Reference Implementation: EFS to S3 Pipeline

> A demonstrator project showcasing production-grade patterns for AWS Lambda functions with OpenTelemetry observability, Result-based error handling, and robust testing strategies.

## Purpose

This repository is a **reference implementation** demonstrating how to build a well-architected Lambda function. While the specific use case (processing zip files from EFS and uploading to S3) is real, the primary goal is to showcase patterns you can adopt in your own serverless applications:

- **OpenTelemetry instrumentation** with semantic conventions for FaaS
- **Result-based error handling** that makes failures explicit and composable
- **Branded types** for compile-time safety of domain values
- **Streaming architectures** for memory-constrained environments
- **Comprehensive testing** including integration tests with testcontainers

## Patterns Demonstrated

### 1. OpenTelemetry Instrumentation

The project uses [@semantic-lambda](https://github.com/djvcom/semantic-lambda) for handler wrapping with automatic FaaS semantic conventions, plus manual spans for business logic:

```typescript
// Handler wrapping with automatic FaaS attributes
import { eventbridgeTrigger, wrap } from '@semantic-lambda/core';

export const handler = wrap(
  tracer,
  eventbridgeTrigger,
  async (event, context) => { /* ... */ }
);

// Manual spans for business operations
return tracer.startActiveSpan('zip.process', { kind: SpanKind.INTERNAL }, async span => {
  span.setAttribute('app.archive.path', zipPath);
  // ... processing logic
  span.setAttribute('app.files.extracted', count);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
});
```

**What you get automatically from `@semantic-lambda/core`:**
- `faas.invocation_id` - Lambda request ID
- `faas.name` - Function name
- `faas.trigger` - Trigger type (pubsub for EventBridge)
- `faas.coldstart` - Cold start detection
- Proper span naming following `{source} {detail-type}` convention

**Manual spans in this project:**
| Span Name | Purpose | Key Attributes |
|-----------|---------|----------------|
| `batch.process` | Overall batch orchestration | `app.config.*`, `app.batch.stopped_early` |
| `filesystem.list_zips` | Directory listing | `app.file.directory`, `app.zip.count` |
| `zip.process` | Individual zip processing | `app.archive.path`, `app.files.*` |
| `s3.upload_batch` | Batched S3 uploads | `aws.s3.bucket`, `rpc.system`, `rpc.service` |

### 2. Result-Based Error Handling

Instead of throwing exceptions, operations return `Result<T, E>` types using [true-myth](https://true-myth.js.org/):

```typescript
// Operations return Result types, making errors explicit
const listResult = await tryListZipFiles(cfg.sourceDir, cfg.minFileAgeMs);

if (listResult.isErr) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: listResult.error.message });
  return Result.err(listResult.error);
}

// Continue with success path
const { files, oldestAgeMs } = listResult.value;
```

**Benefits:**
- Errors are values, not control flow
- TypeScript enforces handling of error cases
- Composable error transformations
- Clear distinction between expected failures and unexpected exceptions

### 3. Branded Types for Domain Safety

Primitive types are branded to prevent mixing incompatible values:

```typescript
// These are incompatible at compile time
type S3Bucket = Brand<string, 'S3Bucket'>;
type S3Key = Brand<string, 'S3Key'>;
type FilePath = Brand<string, 'FilePath'>;

// Constructor validates and brands
export const S3Bucket = (value: string): S3Bucket => {
  const error = validateS3Bucket(value);
  if (error) throw new Error(formatS3BucketError(error));
  return value as S3Bucket;
};
```

### 4. Configuration Validation

Environment variables validated at startup with Zod, failing fast on misconfiguration:

```typescript
const rawConfigSchema = z.object({
  SOURCE_DIR: z.string().min(1),
  DESTINATION_BUCKET: z.string().min(3).max(63),
  BATCH_SIZE: z.preprocess(coerceNumber, z.number().int().positive()).optional(),
  // ...
}).strict();
```

### 5. Testing Strategy

**Unit tests** with dependency isolation:
- `aws-sdk-client-mock` for S3 operations
- `vi.mock` for filesystem and extraction
- `@semantic-lambda/testing` for OTel span verification

**Integration tests** with real dependencies:
- MinIO via testcontainers for S3
- Real filesystem operations
- Full handler execution

```typescript
// OTel span testing
const spans = getExporter().getFinishedSpans();
const processSpan = spans.find(s => s.name === 'zip.process');

expect(processSpan?.attributes['app.files.extracted']).toBe(2);
expect(processSpan?.status.code).toBe(SpanStatusCode.OK);
```

## The Use Case

This Lambda processes zip files deposited on an EFS mount by an external system:

1. **Trigger**: EventBridge schedule (e.g., every minute)
2. **Input**: Zip files in EFS directory
3. **Processing**: Stream-extract, parse content, filter, batch
4. **Output**: XML files uploaded to S3 with UUID prefixes
5. **Cleanup**: Move zips to archive or failed directory

```
EFS (/mnt/efs/input)          Lambda Handler              S3 Bucket
    │                              │                          │
    ├── batch-001.zip ──────────▶ Extract & Parse ─────────▶ prefix/uuid/file1.xml
    ├── batch-002.zip              │                          prefix/uuid/file2.xml
    └── ...                        │
                                   ▼
                         EFS (/mnt/efs/archive)
                              └── batch-001.zip
```

## Quick Start

```bash
# Install dependencies
yarn install

# Run tests
yarn test

# Run with coverage
yarn test:coverage

# Type check
yarn typecheck

# Lint and format
yarn check
yarn format

# Build for Lambda
yarn build
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APP_SOURCE_DIR` | Yes | - | Directory containing zip files |
| `APP_ARCHIVE_DIR` | Yes | - | Directory for processed zips |
| `APP_FAILED_DIR` | Yes | - | Directory for failed zips |
| `APP_DESTINATION_BUCKET` | Yes | - | S3 bucket for uploads |
| `APP_S3_PREFIX_BASE` | No | `""` | Base prefix for S3 keys |
| `APP_BATCH_SIZE` | No | `100` | Files per upload batch |
| `APP_MAX_FILES_PER_INVOCATION` | No | `1000` | Max zips per invocation |
| `APP_TIMEOUT_BUFFER_MS` | No | `30000` | Stop buffer before timeout |
| `APP_FILENAME_PATTERN` | No | - | Regex to extract filename from content |
| `APP_FILTER_PATTERN` | No | - | Regex to filter matching content |
| `APP_DELETE_ON_SUCCESS` | No | `false` | Delete instead of archive |

## Deployment Considerations

### Concurrency Control

For scheduled triggers, use **reserved concurrency = 1**:

```yaml
ZipRelayFunction:
  Type: AWS::Lambda::Function
  Properties:
    ReservedConcurrentExecutions: 1
    Timeout: 300
    MemorySize: 512
```

This prevents overlapping executions. If EventBridge triggers while an invocation is running, Lambda throttles (no retry), and the next scheduled trigger processes remaining files.

### OpenTelemetry Layer

Add the AWS Distro for OpenTelemetry (ADOT) Lambda layer for trace export:

```yaml
Layers:
  - !Sub arn:aws:lambda:${AWS::Region}:901920570463:layer:aws-otel-nodejs-amd64-ver-1-18-1:1
Environment:
  Variables:
    AWS_LAMBDA_EXEC_WRAPPER: /opt/otel-handler
    OTEL_SERVICE_NAME: zip-relay
    OTEL_EXPORTER_OTLP_ENDPOINT: https://your-collector:4318
```

The esbuild configuration includes the OpenTelemetry instrumentation plugin for automatic AWS SDK tracing.

## Architecture

```
src/
├── index.ts              # Lambda handler orchestration
├── config.ts             # Zod schema + layerfig env loader
├── constants.ts          # Service name/version
├── result/               # Result type utilities (true-myth wrapper)
├── errors/               # Typed error hierarchy
├── types/
│   └── branded.ts        # Branded types (S3Bucket, S3Key, FilePath)
├── archive/
│   ├── extractor.ts      # Streaming zip extraction (yauzl)
│   └── types.ts          # ExtractedFile interface
├── content/
│   └── parser.ts         # Regex-based content inspection
├── upload/
│   ├── batcher.ts        # Groups files with UUID prefixes
│   └── uploader.ts       # Batched S3 PutObject with tracing
├── routing/
│   └── file_router.ts    # Archive/failed directory management
├── telemetry/
│   ├── attributes.ts     # Attribute builder utilities
│   ├── logger.ts         # OTel-aware SDK logger
│   └── with_span.ts      # Span wrapper helpers
└── metrics/
    ├── slo.ts            # SLO metrics (oldest zip age, success rate)
    └── resource_monitor.ts # Memory/CPU tracking
```

## Test Coverage

```
161 tests across 10 test files

├── Handler orchestration   21 tests
├── Branded types           59 tests
├── Archive extraction      15 tests
├── File routing            13 tests
├── Config validation       11 tests
├── S3 uploader             10 tests
├── Error types             10 tests
├── Content parser           8 tests
├── OTel spans               8 tests
└── Batcher                  6 tests
```

Integration tests use MinIO via testcontainers for realistic S3 operations.

## What to Take Away

1. **Wrap handlers with semantic conventions** - Use libraries like `@semantic-lambda/core` to get consistent FaaS attributes automatically

2. **Add manual spans for business logic** - Your custom operations need visibility too; name them meaningfully and add domain-specific attributes

3. **Make errors explicit** - Result types force you to handle failures and make error flows visible in code review

4. **Brand your domain types** - `S3Bucket` and `string` are not the same; let the compiler help you

5. **Test your telemetry** - Spans are behaviour; verify they're created with correct attributes

6. **Use testcontainers** - Real S3 (MinIO) catches issues mocks don't

## Licence

MIT
