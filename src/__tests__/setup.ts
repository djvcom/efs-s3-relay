import { existsSync } from 'node:fs';
import { beforeEach } from 'vitest';

import { resetConfig } from '../config';

// Configure testcontainers for Podman if DOCKER_HOST isn't set
// This runs before any tests load testcontainers
if (!process.env['DOCKER_HOST'] && !process.env['TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE']) {
	const podmanSockets = ['/run/podman/podman.sock', '/run/user/1000/podman/podman.sock'];
	for (const socket of podmanSockets) {
		if (existsSync(socket)) {
			process.env['DOCKER_HOST'] = `unix://${socket}`;
			process.env['TESTCONTAINERS_RYUK_DISABLED'] = 'true';
			break;
		}
	}
}

// Reset config before each test to pick up any env var changes
beforeEach(() => {
	resetConfig();
});
