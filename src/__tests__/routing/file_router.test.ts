import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { FilePath } from '../../types/branded';

vi.mock('node:fs/promises', () => ({
	mkdir: vi.fn(),
	rename: vi.fn(),
	unlink: vi.fn(),
	stat: vi.fn(),
}));

import {
	tryDeleteFile,
	tryGetFileAgeMs,
	tryMoveFile,
	tryRouteFile,
} from '../../routing/file_router';

describe('file_router', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(mkdir as Mock).mockResolvedValue(undefined);
		(rename as Mock).mockResolvedValue(undefined);
		(unlink as Mock).mockResolvedValue(undefined);
		(stat as Mock).mockResolvedValue({ mtimeMs: Date.now() - 10_000 });
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	describe('tryMoveFile', () => {
		it('creates destination directory if missing', async () => {
			const result = await tryMoveFile(
				FilePath('/input/batch.zip'),
				FilePath('/archive'),
			).toPromise();

			expect(result.isOk).toBe(true);
			expect(mkdir).toHaveBeenCalledWith('/archive', { recursive: true });
		});

		it('renames file to destination directory', async () => {
			const result = await tryMoveFile(
				FilePath('/input/batch.zip'),
				FilePath('/archive'),
			).toPromise();

			expect(result.isOk).toBe(true);
			expect(rename).toHaveBeenCalledWith('/input/batch.zip', '/archive/batch.zip');
		});

		it('preserves filename when moving', async () => {
			const result = await tryMoveFile(
				FilePath('/path/to/my-file.zip'),
				FilePath('/dest'),
			).toPromise();

			expect(result.isOk).toBe(true);
			expect(rename).toHaveBeenCalledWith('/path/to/my-file.zip', '/dest/my-file.zip');
		});

		it('returns error when mkdir fails', async () => {
			const error = new Error('EACCES: permission denied');
			(mkdir as Mock).mockRejectedValue(error);

			const result = await tryMoveFile(
				FilePath('/input/batch.zip'),
				FilePath('/archive'),
			).toPromise();

			expect(result.isErr).toBe(true);
			if (result.isErr) {
				expect(result.error.message).toContain('/input/batch.zip');
				expect(result.error.operation).toBe('move');
			}
		});

		it('returns error when rename fails', async () => {
			const error = new Error('EXDEV: cross-device link');
			(rename as Mock).mockRejectedValue(error);

			const result = await tryMoveFile(
				FilePath('/input/batch.zip'),
				FilePath('/archive'),
			).toPromise();

			expect(result.isErr).toBe(true);
			if (result.isErr) {
				expect(result.error.operation).toBe('move');
			}
		});
	});

	describe('tryDeleteFile', () => {
		it('deletes file at path', async () => {
			const result = await tryDeleteFile(FilePath('/input/batch.zip')).toPromise();

			expect(result.isOk).toBe(true);
			expect(unlink).toHaveBeenCalledWith('/input/batch.zip');
		});

		it('returns error when unlink fails', async () => {
			const error = new Error('ENOENT: no such file');
			(unlink as Mock).mockRejectedValue(error);

			const result = await tryDeleteFile(FilePath('/input/batch.zip')).toPromise();

			expect(result.isErr).toBe(true);
			if (result.isErr) {
				expect(result.error.operation).toBe('delete');
			}
		});
	});

	describe('tryGetFileAgeMs', () => {
		it('returns file age in milliseconds', async () => {
			const nowMs = Date.now();
			(stat as Mock).mockResolvedValue({ mtimeMs: nowMs - 5000 });

			const result = await tryGetFileAgeMs(FilePath('/input/batch.zip')).toPromise();

			expect(result.isOk).toBe(true);
			if (result.isOk) {
				expect(result.value).toBeGreaterThanOrEqual(5000);
				expect(result.value).toBeLessThan(6000);
			}
		});

		it('returns error when stat fails', async () => {
			const error = new Error('ENOENT: no such file');
			(stat as Mock).mockRejectedValue(error);

			const result = await tryGetFileAgeMs(FilePath('/input/batch.zip')).toPromise();

			expect(result.isErr).toBe(true);
			if (result.isErr) {
				expect(result.error.operation).toBe('stat');
			}
		});
	});

	describe('tryRouteFile', () => {
		describe('success routing', () => {
			it('moves to archive when deleteOnSuccess is false', async () => {
				const result = await tryRouteFile(
					FilePath('/input/batch.zip'),
					true,
					FilePath('/archive'),
					FilePath('/failed'),
					false,
				).toPromise();

				expect(result.isOk).toBe(true);
				expect(mkdir).toHaveBeenCalledWith('/archive', { recursive: true });
				expect(rename).toHaveBeenCalledWith('/input/batch.zip', '/archive/batch.zip');
				expect(unlink).not.toHaveBeenCalled();
			});

			it('deletes file when deleteOnSuccess is true', async () => {
				const result = await tryRouteFile(
					FilePath('/input/batch.zip'),
					true,
					FilePath('/archive'),
					FilePath('/failed'),
					true,
				).toPromise();

				expect(result.isOk).toBe(true);
				expect(unlink).toHaveBeenCalledWith('/input/batch.zip');
				expect(rename).not.toHaveBeenCalled();
			});
		});

		describe('failure routing', () => {
			it('moves to failed directory when success is false', async () => {
				const result = await tryRouteFile(
					FilePath('/input/batch.zip'),
					false,
					FilePath('/archive'),
					FilePath('/failed'),
					false,
				).toPromise();

				expect(result.isOk).toBe(true);
				expect(mkdir).toHaveBeenCalledWith('/failed', { recursive: true });
				expect(rename).toHaveBeenCalledWith('/input/batch.zip', '/failed/batch.zip');
			});

			it('moves to failed directory even when deleteOnSuccess is true', async () => {
				const result = await tryRouteFile(
					FilePath('/input/batch.zip'),
					false,
					FilePath('/archive'),
					FilePath('/failed'),
					true,
				).toPromise();

				expect(result.isOk).toBe(true);
				expect(rename).toHaveBeenCalledWith('/input/batch.zip', '/failed/batch.zip');
				expect(unlink).not.toHaveBeenCalled();
			});
		});
	});
});
