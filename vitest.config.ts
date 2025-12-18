import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Auto-detect Podman socket for testcontainers
function detectDockerHost(): string | undefined {
	if (process.env['DOCKER_HOST']) return process.env['DOCKER_HOST'];
	const sockets = ['/run/podman/podman.sock', '/run/user/1000/podman/podman.sock'];
	for (const socket of sockets) {
		if (existsSync(socket)) return `unix://${socket}`;
	}
	return undefined;
}

const dockerHost = detectDockerHost();

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['src/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
		setupFiles: ['src/__tests__/setup.ts'],
		testTimeout: 60_000, // Generous for integration tests
		hookTimeout: 60_000, // Container startup can be slow
		env: {
			// Silence logs during tests (only show errors)
			LOG_LEVEL: 'error',
			// layerfig uses APP_ prefix by default (unit tests)
			// Integration tests override these with real values
			APP_SOURCE_DIR: '/input',
			APP_ARCHIVE_DIR: '/archived',
			APP_FAILED_DIR: '/failed',
			APP_DESTINATION_BUCKET: 'test-bucket',
			APP_S3_PREFIX_BASE: 'transactions/input',
			APP_BATCH_SIZE: '100',
			APP_MAX_FILES_PER_INVOCATION: '1000',
			APP_TIMEOUT_BUFFER_MS: '30000',
			APP_MIN_FILE_AGE_MS: '0',
			APP_DELETE_ON_SUCCESS: 'false',
			AWS_REGION: 'eu-west-1',
			// Testcontainers config for Podman
			...(dockerHost && { DOCKER_HOST: dockerHost }),
			TESTCONTAINERS_RYUK_DISABLED: 'true',
		},
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/__tests__/**', 'src/__benchmarks__/**', 'src/instrumentation.ts'],
		},
		benchmark: {
			include: ['src/__benchmarks__/**/*.bench.ts'],
		},
	},
});
