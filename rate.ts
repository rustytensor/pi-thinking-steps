// Prompt rate uses tokens the provider had to process (input + cache write)
// over the time from request start to the first generated token. Cache reads
// are excluded. Generation rate uses output tokens, which already include
// reasoning, over the time after that first token.

export interface RateUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RateClock {
	now(): number;
	mono(): number;
}

export interface RateMeter {
	begin(startedAtMs: number): void;
	noteFirstOutput(): void;
	noteUsage(usage: RateUsage): void;
	finish(durationMs: number | undefined, usage: RateUsage | undefined): void;
	reset(): void;
	statusText(): string | undefined;
}

const FIRST_OUTPUT_EVENTS = new Set(["thinking_delta", "text_delta", "toolcall_start", "toolcall_delta"]);

interface RateSample {
	startedAtMs: number;
	seenAtMs: number;
	seenMono: number;
	firstTokenMono?: number;
	durationMs?: number;
	finished: boolean;
	usage?: RateUsage;
}

export function isFirstOutputEvent(type: string): boolean {
	return FIRST_OUTPUT_EVENTS.has(type);
}

export function readRateUsage(message: { usage?: unknown }): RateUsage | undefined {
	const usage = message.usage;
	if (!isRateUsage(usage)) return undefined;
	return usage;
}

export function readDurationMs(message: unknown): number | undefined {
	if (!message || typeof message !== "object" || !("durationMs" in message)) return undefined;
	const durationMs = message.durationMs;
	return typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : undefined;
}

export function readStartedAtMs(message: { timestamp?: unknown }, fallback: number): number {
	return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : fallback;
}

export function promptTokenCount(usage: RateUsage): number {
	return Math.max(0, usage.input) + Math.max(0, usage.cacheWrite);
}

export function generationTokenCount(usage: RateUsage): number {
	return Math.max(0, usage.output);
}

export function tokensPerSecond(tokens: number, elapsedMs: number): number | undefined {
	if (!Number.isFinite(tokens) || !Number.isFinite(elapsedMs) || tokens <= 0 || elapsedMs < 1) return undefined;
	return (tokens * 1000) / elapsedMs;
}

export function formatTokensPerSecond(rate: number): string {
	if (!Number.isFinite(rate) || rate < 0) return "0";
	if (rate < 10) return rate.toFixed(1);
	if (rate < 1000) return String(Math.round(rate));
	if (rate < 10_000) return `${(rate / 1000).toFixed(1)}k`;
	if (rate < 1_000_000) return `${Math.round(rate / 1000)}k`;
	if (rate < 10_000_000) return `${(rate / 1_000_000).toFixed(1)}M`;
	return `${Math.round(rate / 1_000_000)}M`;
}

export function createRateMeter(clock: RateClock = { now: () => Date.now(), mono: () => performance.now() }): RateMeter {
	let sample: RateSample | undefined;

	const elapsed = (current: RateSample, mono: number): number => {
		return Math.max(0, (current.seenAtMs - current.startedAtMs) + (mono - current.seenMono));
	};

	const windows = (current: RateSample, monoNow: number): { promptMs?: number; generationMs?: number } => {
		const measuredTotal = elapsed(current, monoNow);
		const totalMs = current.finished && current.durationMs !== undefined && current.durationMs + 50 >= measuredTotal
			? current.durationMs
			: measuredTotal;
		if (current.firstTokenMono === undefined) return {};
		const promptMs = elapsed(current, current.firstTokenMono);
		if (promptMs > totalMs) return { promptMs: totalMs };
		return { promptMs, generationMs: totalMs - promptMs };
	};

	return {
		begin(startedAtMs: number): void {
			const seenAtMs = clock.now();
			sample = {
				startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : seenAtMs,
				seenAtMs,
				seenMono: clock.mono(),
				finished: false,
			};
		},
		noteFirstOutput(): void {
			if (!sample || sample.finished || sample.firstTokenMono !== undefined) return;
			sample.firstTokenMono = clock.mono();
		},
		noteUsage(usage: RateUsage): void {
			if (!sample || sample.finished || !hasReportedTokens(usage)) return;
			sample.usage = usage;
		},
		finish(durationMs: number | undefined, usage: RateUsage | undefined): void {
			if (!sample || sample.finished) return;
			sample.finished = true;
			if (durationMs !== undefined && Number.isFinite(durationMs)) sample.durationMs = durationMs;
			if (usage) sample.usage = usage;
		},
		reset(): void {
			sample = undefined;
		},
		statusText(): string | undefined {
			if (!sample) return undefined;
			const span = windows(sample, clock.mono());
			const usage = sample.usage;
			const promptRate = usage ? tokensPerSecond(promptTokenCount(usage), span.promptMs ?? Number.NaN) : undefined;
			const generationRate = usage ? tokensPerSecond(generationTokenCount(usage), span.generationMs ?? Number.NaN) : undefined;
			const parts: string[] = [];
			if (promptRate !== undefined) parts.push(`prompt ${formatTokensPerSecond(promptRate)}/s`);
			else if (!sample.finished) parts.push("prompt ...");
			if (generationRate !== undefined) parts.push(`gen ${formatTokensPerSecond(generationRate)}/s`);
			else if (!sample.finished && sample.firstTokenMono !== undefined) parts.push("gen ...");
			return parts.length > 0 ? parts.join(" · ") : undefined;
		},
	};
}

function isRateUsage(value: unknown): value is RateUsage {
	if (!value || typeof value !== "object") return false;
	const record = value as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
	return isFiniteCount(record.input) && isFiniteCount(record.output) && isFiniteCount(record.cacheRead) && isFiniteCount(record.cacheWrite);
}

function isFiniteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasReportedTokens(usage: RateUsage): boolean {
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
}
