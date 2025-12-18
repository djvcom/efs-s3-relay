import {
	createMockEventBridgeEvent,
	createMockContext as createSemanticMockContext,
} from '@semantic-lambda/testing';
import type { Context, ScheduledEvent } from 'aws-lambda';
import { vi } from 'vitest';

export class ContextBuilder {
	private awsRequestId = 'test-request-id';
	private functionName = 'test-function';
	private functionVersion = '1';
	private invokedFunctionArn = 'arn:aws:lambda:eu-west-1:123456789:function:test';
	private memoryLimitInMB = '128';
	private remainingTimeMs = 300_000;
	private remainingTimeSequence: readonly number[] | undefined;

	withRequestId(id: string): this {
		this.awsRequestId = id;
		return this;
	}

	withFunctionName(name: string): this {
		this.functionName = name;
		return this;
	}

	withRemainingTime(ms: number): this {
		this.remainingTimeMs = ms;
		return this;
	}

	withRemainingTimeSequence(times: readonly number[]): this {
		this.remainingTimeSequence = times;
		return this;
	}

	withMemoryLimit(mb: string): this {
		this.memoryLimitInMB = mb;
		return this;
	}

	build(): Context {
		const context = createSemanticMockContext({
			awsRequestId: this.awsRequestId,
			functionName: this.functionName,
			functionVersion: this.functionVersion,
			invokedFunctionArn: this.invokedFunctionArn,
			memoryLimitInMB: this.memoryLimitInMB,
			remainingTimeMs: this.remainingTimeMs,
		});

		if (this.remainingTimeSequence) {
			let callCount = 0;
			const times = this.remainingTimeSequence;
			context.getRemainingTimeInMillis = () => {
				const time = times[callCount] ?? times[times.length - 1] ?? 0;
				callCount++;
				return time;
			};
		}

		context.done = vi.fn();
		context.fail = vi.fn();
		context.succeed = vi.fn();

		return context;
	}
}

export class ScheduledEventBuilder {
	private id = 'test-event-id';
	private account = '123456789012';
	private region = 'eu-west-1';
	private time = '2024-01-01T00:00:00Z';
	private ruleArn = 'arn:aws:events:eu-west-1:123456789012:rule/test-rule';

	withId(id: string): this {
		this.id = id;
		return this;
	}

	withAccount(account: string): this {
		this.account = account;
		return this;
	}

	withRegion(region: string): this {
		this.region = region;
		return this;
	}

	withTime(time: string): this {
		this.time = time;
		return this;
	}

	build(): ScheduledEvent {
		return createMockEventBridgeEvent({
			id: this.id,
			account: this.account,
			region: this.region,
			time: this.time,
			source: 'aws.events',
			detailType: 'Scheduled Event',
			detail: {},
			resources: [this.ruleArn],
		}) as ScheduledEvent;
	}
}

export function createMockContext(): Context {
	return new ContextBuilder().build();
}

export function createMockScheduledEvent(): ScheduledEvent {
	return new ScheduledEventBuilder().build();
}
