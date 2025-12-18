import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { build } from 'esbuild';
import { openTelemetryPlugin } from 'opentelemetry-esbuild-plugin-node';

await build({
	entryPoints: ['src/index.ts'],
	bundle: true,
	platform: 'node',
	target: 'node24',
	format: 'esm',
	outfile: 'dist/index.mjs',
	sourcemap: true,
	minify: true,
	plugins: [
		openTelemetryPlugin({
			instrumentations: getNodeAutoInstrumentations({
				'@opentelemetry/instrumentation-fs': {},
				'@opentelemetry/instrumentation-aws-sdk': {
					suppressInternalInstrumentation: true,
				},
			}),
		}),
	],
	banner: {
		js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
	},
});

console.log('Build complete');
