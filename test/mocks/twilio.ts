import { vi } from "vitest";

type MockFn<T extends (...args: never[]) => unknown> = ReturnType<typeof vi.fn<T>>;

export type MockTwilioClient = {
	messages: ((sid?: string) => { fetch: MockFn<() => unknown> }) & {
		create: MockFn<() => unknown>;
		list: MockFn<() => unknown>;
	};
	request?: MockFn<() => unknown>;
	messaging?: {
		v2: { channelsSenders: ((sid?: string) => { fetch: MockFn<() => unknown>; update: MockFn<() => unknown> }) & { list: MockFn<() => unknown> } };
		v1: { services: MockFn<() => { update: MockFn<() => unknown>; fetch: MockFn<() => unknown> }> };
	};
	incomingPhoneNumbers?: ((sid?: string) => { update: MockFn<() => unknown> }) & {
		list: MockFn<() => unknown>;
	};
};

export function createMockTwilio() {
	const messages = Object.assign(vi.fn((sid?: string) => ({ fetch: vi.fn() })), {
		create: vi.fn(),
		list: vi.fn(),
	});

	const channelsSenders = Object.assign(
		vi.fn((sid?: string) => ({ fetch: vi.fn(), update: vi.fn() })),
		{ list: vi.fn() },
	);

	const services = vi.fn(() => ({ update: vi.fn(), fetch: vi.fn() }));

	const incomingPhoneNumbers = Object.assign(
		vi.fn((sid?: string) => ({ update: vi.fn() })),
		{ list: vi.fn() },
	);

	const client: MockTwilioClient = {
		messages,
		request: vi.fn(),
		messaging: {
			v2: { channelsSenders },
			v1: { services },
		},
		incomingPhoneNumbers,
	};

	const factory = Object.assign(vi.fn(() => client), {
		_client: client,
		_createClient: () => client,
	});

	return { client, factory };
}
