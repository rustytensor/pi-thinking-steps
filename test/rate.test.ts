import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateMeter, formatTokensPerSecond, generationTokenCount, promptTokenCount, tokensPerSecond, type RateClock, type RateUsage } from "../rate.js";

function clockAt(startNow: number, startMono: number): RateClock & { set(now: number, mono: number): void } {
	let now = startNow;
	let mono = startMono;
	return {
		now: () => now,
		mono: () => mono,
		set(nextNow: number, nextMono: number) {
			now = nextNow;
			mono = nextMono;
		},
	};
}

const cachedPrompt: RateUsage = { input: 800, output: 0, cacheRead: 5000, cacheWrite: 0 };
const finishedPrompt: RateUsage = { input: 800, output: 80, cacheRead: 5000, cacheWrite: 0 };

describe("token rates", () => {
	it("formats rates from precomputed token and time counts", () => {
		assert.equal(promptTokenCount({ input: 10, output: 5, cacheRead: 1000, cacheWrite: 90 }), 100);
		assert.equal(generationTokenCount({ input: 10, output: 5, cacheRead: 1000, cacheWrite: 90 }), 5);
		assert.equal(tokensPerSecond(800, 400), 2000);
		assert.equal(tokensPerSecond(80, 1600), 50);
		assert.equal(tokensPerSecond(42, 10_000), 4.2);
		assert.equal(tokensPerSecond(0, 1000), undefined);
		assert.equal(tokensPerSecond(100, 0), undefined);
		assert.equal(tokensPerSecond(100, 0.4), undefined);
		assert.equal(formatTokensPerSecond(4.2), "4.2");
		assert.equal(formatTokensPerSecond(40), "40");
		assert.equal(formatTokensPerSecond(999), "999");
		assert.equal(formatTokensPerSecond(1000), "1,000");
		assert.equal(formatTokensPerSecond(2000), "2,000");
		assert.equal(formatTokensPerSecond(10_000), "10,000");
		assert.equal(formatTokensPerSecond(1_500_000), "1,500,000");
	});

	it("shows prompt processing and generation rates without counting cache reads", () => {
		const clock = clockAt(10_000, 100);
		const meter = createRateMeter(clock);
		assert.equal(meter.statusText(), undefined);

		meter.begin(10_000);
		assert.equal(meter.statusText(), "now · in ...");
		assert.equal(meter.statusText("session"), "session · no rates yet");

		clock.set(10_000, 500);
		meter.noteFirstOutput();
		meter.noteUsage(cachedPrompt);
		assert.equal(meter.statusText(), "now · in 2,000 tok/s · out ...");

		clock.set(10_000, 2100);
		meter.finish(2000, finishedPrompt);
		assert.equal(meter.statusText(), "now · in 2,000 tok/s · out 50 tok/s");
	});

	it("counts cache writes as processed prompt tokens and omits a full cache hit", () => {
		const clock = clockAt(1_000, 0);
		const meter = createRateMeter(clock);
		meter.begin(1_000);
		clock.set(1_000, 100);
		meter.noteFirstOutput();
		meter.noteUsage({ input: 10, output: 0, cacheRead: 0, cacheWrite: 90 });
		assert.equal(meter.statusText(), "now · in 1,000 tok/s · out ...");

		const cachedClock = clockAt(1_000, 0);
		const cached = createRateMeter(cachedClock);
		cached.begin(1_000);
		cachedClock.set(1_000, 100);
		cached.noteFirstOutput();
		cachedClock.set(1_000, 1100);
		cached.finish(1100, { input: 0, output: 10, cacheRead: 10_000, cacheWrite: 0 });
		assert.equal(cached.statusText(), "now · out 10 tok/s");
	});

	it("does not invent a split when no generated token was observed", () => {
		const clock = clockAt(5_000, 0);
		const meter = createRateMeter(clock);
		meter.begin(5_000);
		clock.set(5_000, 2000);
		meter.finish(2000, { input: 100, output: 80, cacheRead: 0, cacheWrite: 0 });
		assert.equal(meter.statusText(), undefined);
		meter.reset();
		assert.equal(meter.statusText(), undefined);
	});

	it("averages a session by total tokens over total time", () => {
		const clock = clockAt(10_000, 100);
		const meter = createRateMeter(clock);
		meter.begin(10_000);
		clock.set(10_000, 500);
		meter.noteFirstOutput();
		clock.set(10_000, 2100);
		meter.finish(2000, finishedPrompt);

		clock.set(20_000, 3000);
		meter.begin(20_000);
		clock.set(20_000, 3200);
		meter.noteFirstOutput();
		clock.set(20_000, 4000);
		meter.finish(1000, { input: 200, output: 40, cacheRead: 0, cacheWrite: 0 });

		assert.equal(meter.statusText(), "now · in 1,000 tok/s · out 50 tok/s");
		assert.equal(meter.statusText("session"), "session · in 1,667 tok/s · out 50 tok/s");
	});
});
