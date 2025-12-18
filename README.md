# zip-relay

AWS Lambda function for processing zip files from an EFS-mounted filesystem, extracting contents, and uploading to S3. Designed for constrained Lambda environments with streaming extraction and batched uploads.

## Features

- **Streaming zip extraction**: Uses `yauzl` for memory-efficient extraction
- **Configurable content parsing**: Regex-based filename extraction and filtering
- **Batched S3 uploads**: UUID-prefixed batches for S3 request rate distribution
- **Partial failure handling**: Continues processing when individual files fail
- **Timeout awareness**: Gracefully stops before Lambda timeout
- **File routing**: Moves processed zips to archive/failed directories
- **OpenTelemetry instrumentation**: Full tracing with manual spans and auto-instrumentation

## Environment Variables

All environment variables use the `APP_` prefix.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APP_SOURCE_DIR` | Yes | - | Directory containing zip files to process |
| `APP_ARCHIVE_DIR` | Yes | - | Directory for successfully processed zips |
| `APP_FAILED_DIR` | Yes | - | Directory for failed zips |
| `APP_DESTINATION_BUCKET` | Yes | - | S3 bucket for uploads |
| `APP_S3_PREFIX_BASE` | No | `""` | Base prefix for S3 keys |
| `APP_BATCH_SIZE` | No | `100` | Files per S3 batch (for rate limiting) |
| `APP_MAX_FILES_PER_INVOCATION` | No | `1000` | Max zips to process per invocation |
| `APP_TIMEOUT_BUFFER_MS` | No | `30000` | Stop processing this many ms before timeout |
| `APP_FILENAME_PATTERN` | No | - | Regex to extract filename from content |
| `APP_FILTER_PATTERN` | No | - | Regex to filter out matching content |
| `APP_DELETE_ON_SUCCESS` | No | `false` | Delete zips instead of archiving |

## Configuration Examples

### Filename Extraction

Extract transaction ID from XML content to use as filename:

```bash
APP_FILENAME_PATTERN='<transactionId>(.*?)</transactionId>'
```

Input: `<root><transactionId>TXN-12345</transactionId></root>`
Output filename: `TXN-12345.xml`

### Content Filtering

Skip files matching a pattern (e.g., test transactions):

```bash
APP_FILTER_PATTERN='<locationId>PERF-TEST</locationId>'
```

## IAM Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::your-bucket/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "elasticfilesystem:ClientMount",
        "elasticfilesystem:ClientWrite"
      ],
      "Resource": "arn:aws:efs:region:account-id:file-system/fs-xxxxxxxx"
    }
  ]
}
```

## Development

```bash
yarn install        # Install dependencies
yarn build          # Bundle for Lambda using esbuild
yarn test           # Run tests
yarn test:watch     # Run tests in watch mode
yarn test:coverage  # Run tests with coverage
yarn typecheck      # TypeScript type checking
yarn format         # Format code with Biome
yarn lint           # Lint code with Biome
yarn check          # Run all Biome checks
```

## Architecture

```
src/
├── index.ts              # Lambda handler orchestration
├── config.ts             # Zod schema + env loader
├── archive/
│   ├── extractor.ts      # Streaming zip extraction (yauzl)
│   └── types.ts          # ExtractedFile types
├── content/
│   └── parser.ts         # Regex-based content inspection
├── upload/
│   ├── batcher.ts        # Groups files with UUID prefixes
│   └── uploader.ts       # S3 PutObject with tracing
└── routing/
    └── file_router.ts    # Archive/failed directory management
```

## Processing Flow

```
EFS (source_dir)
    │
    ├── batch-001.zip
    ├── batch-002.zip
    └── ...
         │
         ▼
    Lambda Handler
         │
         ├── List zip files (up to max_files_per_invocation)
         ├── For each zip:
         │   ├── Stream extract with yauzl
         │   ├── For each extracted file:
         │   │   ├── Apply filter pattern (skip if match)
         │   │   └── Extract filename from content
         │   ├── Batch files (100 per batch)
         │   ├── Upload batches to S3 with UUID prefix
         │   └── Route zip to archive/failed
         └── Return BatchResult
         │
         ▼
    S3 Bucket
         │
         └── {prefix}/{uuid}/{filename}.xml
```

## Response Format

```typescript
{
  zipsProcessed: number;
  zipsFailed: number;
  totalFilesUploaded: number;
  totalFilesFailed: number;
  totalFilesFiltered: number;
  results: ZipProcessResult[];
  stoppedEarly: boolean;
}
```

## Deployment

### Lambda Configuration

- **Runtime**: Node.js 24.x
- **Handler**: `index.handler`
- **Memory**: 256 MB minimum
- **Timeout**: 300 seconds (5 minutes) recommended
- **Architecture**: x86_64 or arm64
- **Reserved Concurrency**: 1 (required for scheduled triggers)

### Concurrency Control for Scheduled Triggers

When running on a schedule (e.g., EventBridge cron), configure **reserved concurrency = 1** to prevent overlapping executions. This ensures:

1. **No duplicate processing**: Only one instance processes files at a time
2. **Graceful throttling**: If the previous invocation is still running when the schedule triggers, Lambda returns a throttle error. EventBridge does not retry throttled invocations.
3. **Natural catch-up**: The next scheduled trigger will process remaining files

**Recommended configuration:**

| Setting | Value | Rationale |
|---------|-------|-----------|
| Reserved Concurrency | 1 | Prevents overlap |
| Timeout | 300s (5 min) | Allows batch completion |
| `TIMEOUT_BUFFER_MS` | 30000 | Stops 30s before timeout |
| `MAX_FILES_PER_INVOCATION` | 50-100 | Tune based on file size |
| Schedule Rate | 1 minute | Frequent polling for new files |

**CloudFormation example:**

```yaml
ZipRelayFunction:
  Type: AWS::Lambda::Function
  Properties:
    FunctionName: zip-relay
    Runtime: nodejs24.x
    Handler: index.handler
    Timeout: 300
    ReservedConcurrentExecutions: 1
    MemorySize: 512
    FileSystemConfigs:
      - Arn: !GetAtt EfsAccessPoint.Arn
        LocalMountPath: /mnt/efs
    Environment:
      Variables:
        APP_SOURCE_DIR: /mnt/efs/input
        APP_ARCHIVE_DIR: /mnt/efs/archive
        APP_FAILED_DIR: /mnt/efs/failed
        APP_DESTINATION_BUCKET: !Ref DestinationBucket
        APP_MAX_FILES_PER_INVOCATION: "100"

ZipRelaySchedule:
  Type: AWS::Events::Rule
  Properties:
    ScheduleExpression: rate(1 minute)
    State: ENABLED
    Targets:
      - Id: ZipRelayTarget
        Arn: !GetAtt ZipRelayFunction.Arn
```

**Behaviour matrix:**

| Scenario | Outcome |
|----------|---------|
| Schedule triggers, no running instance | Normal execution |
| Schedule triggers, instance running | Throttled (no retry) |
| Instance completes before timeout | All files processed, moves to archive |
| Timeout approaching | `stoppedEarly: true`, remaining files processed next invocation |
| Individual file fails | Continues processing, zip moved to failed directory |

### OpenTelemetry

Add an OpenTelemetry Lambda layer (e.g., AWS Distro for OpenTelemetry). The esbuild plugin automatically instruments AWS SDK and fs operations.

## Licence

ISC
