import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

// Get current user's UID for rootless Podman socket path
function getUserId(): string {
	try {
		return execSync('id -u', { encoding: 'utf8' }).trim();
	} catch {
		return '1000';
	}
}

// Common container runtime socket locations
function getSocketPaths(): string[] {
	const uid = getUserId();
	return [
		'/var/run/docker.sock', // Docker
		'/run/podman/podman.sock', // Podman (rootful)
		`/run/user/${uid}/podman/podman.sock`, // Podman (rootless)
	];
}

// Check if container runtime is available and accessible
function checkSocketAccessible(socket: string): boolean {
	if (!existsSync(socket)) return false;
	try {
		execSync(`test -r "${socket}" && test -w "${socket}"`, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

export function isContainerRuntimeAvailable(): boolean {
	// Check DOCKER_HOST if set
	if (process.env['DOCKER_HOST']) {
		const socketPath = process.env['DOCKER_HOST'].replace('unix://', '');
		return checkSocketAccessible(socketPath);
	}

	// Check common socket locations
	return getSocketPaths().some(checkSocketAccessible);
}

// Configure testcontainers for Podman if DOCKER_HOST isn't set
if (!process.env['DOCKER_HOST'] && !process.env['TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE']) {
	for (const socket of getSocketPaths()) {
		if (existsSync(socket)) {
			process.env['DOCKER_HOST'] = `unix://${socket}`;
			process.env['TESTCONTAINERS_RYUK_DISABLED'] = 'true';
			break;
		}
	}
}

export interface MinioConfig {
	readonly endpoint: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly region: string;
}

const MINIO_ROOT_USER = 'minioadmin';
const MINIO_ROOT_PASSWORD = 'minioadmin';
const MINIO_PORT = 9000;

let container: StartedTestContainer | undefined;

export async function startMinioContainer(): Promise<MinioConfig> {
	container = await new GenericContainer('minio/minio:latest')
		.withExposedPorts(MINIO_PORT)
		.withEnvironment({
			MINIO_ROOT_USER,
			MINIO_ROOT_PASSWORD,
		})
		.withCommand(['server', '/data'])
		.withWaitStrategy(Wait.forHttp('/minio/health/ready', MINIO_PORT).withStartupTimeout(30_000))
		.start();

	const host = container.getHost();
	const port = container.getMappedPort(MINIO_PORT);

	return {
		endpoint: `http://${host}:${port}`,
		accessKeyId: MINIO_ROOT_USER,
		secretAccessKey: MINIO_ROOT_PASSWORD,
		region: 'us-east-1',
	};
}

export async function stopMinioContainer(): Promise<void> {
	if (container) {
		await container.stop();
		container = undefined;
	}
}
