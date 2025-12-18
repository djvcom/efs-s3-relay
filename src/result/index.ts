import { Result, Task, task } from 'true-myth';

import type { AppError } from '../errors';

export { Result, Task };
export type { Unit } from 'true-myth';

export type AsyncResult<T, E extends AppError> = Task<T, E>;

export const ok = Result.ok;
export const err = Result.err;

export function tryAsync<T, E extends AppError>(
	fn: () => Promise<T>,
	onError: (error: unknown) => E,
): AsyncResult<T, E> {
	return task.tryOrElse(onError, fn);
}

export function fromResult<T, E extends AppError>(result: Result<T, E>): AsyncResult<T, E> {
	return result.isOk ? Task.resolve(result.value) : Task.reject(result.error);
}

export async function collectResults<T, E extends AppError>(
	results: readonly Result<T, E>[],
): Promise<Result<readonly T[], E>> {
	const values: T[] = [];
	for (const result of results) {
		if (result.isErr) {
			return Result.err(result.error);
		}
		values.push(result.value);
	}
	return Result.ok(values);
}

export function partitionResults<T, E extends AppError>(
	results: readonly Result<T, E>[],
): { readonly successes: readonly T[]; readonly failures: readonly E[] } {
	const successes: T[] = [];
	const failures: E[] = [];

	for (const result of results) {
		if (result.isOk) {
			successes.push(result.value);
		} else {
			failures.push(result.error);
		}
	}

	return { successes, failures };
}
