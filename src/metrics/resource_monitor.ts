import type { Span } from '@opentelemetry/api';

export interface ResourceSnapshot {
	readonly memoryUsedMb: number;
	readonly memoryHeapUsedMb: number;
	readonly memoryHeapTotalMb: number;
	readonly memoryExternalMb: number;
	readonly cpuUserMs: number;
	readonly cpuSystemMs: number;
}

export function captureResourceSnapshot(): ResourceSnapshot {
	const memory = process.memoryUsage();
	const cpu = process.cpuUsage();

	return {
		memoryUsedMb: memory.rss / 1024 / 1024,
		memoryHeapUsedMb: memory.heapUsed / 1024 / 1024,
		memoryHeapTotalMb: memory.heapTotal / 1024 / 1024,
		memoryExternalMb: memory.external / 1024 / 1024,
		cpuUserMs: cpu.user / 1000,
		cpuSystemMs: cpu.system / 1000,
	};
}

export function recordResourceMetrics(
	span: Span,
	prefix: string,
	snapshot: ResourceSnapshot,
): void {
	span.setAttribute(`${prefix}.memory_used_mb`, snapshot.memoryUsedMb);
	span.setAttribute(`${prefix}.memory_heap_used_mb`, snapshot.memoryHeapUsedMb);
	span.setAttribute(`${prefix}.memory_heap_total_mb`, snapshot.memoryHeapTotalMb);
	span.setAttribute(`${prefix}.memory_external_mb`, snapshot.memoryExternalMb);
	span.setAttribute(`${prefix}.cpu_user_ms`, snapshot.cpuUserMs);
	span.setAttribute(`${prefix}.cpu_system_ms`, snapshot.cpuSystemMs);
}

export function recordResourceDelta(
	span: Span,
	start: ResourceSnapshot,
	end: ResourceSnapshot,
): void {
	span.setAttribute('resource.memory_delta_mb', end.memoryUsedMb - start.memoryUsedMb);
	span.setAttribute('resource.heap_delta_mb', end.memoryHeapUsedMb - start.memoryHeapUsedMb);
	span.setAttribute('resource.cpu_user_delta_ms', end.cpuUserMs - start.cpuUserMs);
	span.setAttribute('resource.cpu_system_delta_ms', end.cpuSystemMs - start.cpuSystemMs);
	span.setAttribute(
		'resource.cpu_total_delta_ms',
		end.cpuUserMs - start.cpuUserMs + (end.cpuSystemMs - start.cpuSystemMs),
	);
}
