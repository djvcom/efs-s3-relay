export type ErrorContext = string;

export abstract class AppError extends Error {
	abstract readonly code: string;
	readonly context: readonly ErrorContext[];
	override readonly cause?: Error;
	readonly timestamp: Date;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = this.constructor.name;
		this.context = [];
		this.timestamp = new Date();

		if (cause instanceof Error) {
			this.cause = cause;
		} else if (cause !== undefined) {
			this.cause = new Error(String(cause));
		}

		Error.captureStackTrace?.(this, this.constructor);
	}

	withContext(ctx: ErrorContext): this {
		const clone = Object.create(Object.getPrototypeOf(this)) as this;
		Object.assign(clone, this);
		(clone as unknown as { context: ErrorContext[] }).context = [...this.context, ctx];
		return clone;
	}

	get rootCause(): Error {
		if (this.cause instanceof AppError) {
			return this.cause.rootCause;
		}
		return this.cause ?? this;
	}

	get fullMessage(): string {
		const parts = [this.message];
		if (this.context.length > 0) {
			parts.push(`Context: ${this.context.join(' → ')}`);
		}
		if (this.cause) {
			parts.push(`Caused by: ${this.cause.message}`);
		}
		return parts.join('\n');
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			context: this.context,
			cause: this.cause?.message,
			timestamp: this.timestamp.toISOString(),
		};
	}
}
