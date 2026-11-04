import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import { AssistantMessageComponent as HostAssistantMessageComponent, getPackageDir, type MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { Spacer, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { decrementPatchRefCount, getPatchCleanup, getPatchInstallPromise, incrementPatchRefCount, resolveThinkingMessageScope, setPatchCleanup, setPatchInstallPromise } from "./state.js";
import { ThinkingStepsComponent } from "./render.js";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "./types.js";

export const PI_CODING_AGENT_INTERNAL_MODULES = {
	assistantMessageComponent: "dist/modes/interactive/components/assistant-message.js",
	theme: "dist/modes/interactive/theme/theme.js",
	markdownTransform: "dist/modes/interactive/components/markdown-transform.js",
} as const;

interface AssistantMessageComponentPrototype {
	updateContent(message: AssistantMessage, isStreaming?: boolean): void;
	setHideThinkingBlock(hide: boolean): void;
	setHiddenThinkingLabel(label: string): void;
	contentContainer: {
		children: Component[];
		clear(): void;
		addChild(component: Component): void;
	};
	lastMessage?: AssistantMessage;
	hideThinkingBlock: boolean;
	markdownTheme: MarkdownTheme;
	hiddenThinkingLabel: string;
	outputPad: number;
	markdownTransformers: MarkdownTransformer[];
	isStreaming: boolean;
	hasToolCalls: boolean;
}

export function assertPatchableAssistantMessageComponent(value: unknown): { prototype: AssistantMessageComponentPrototype } {
	if (!value || (typeof value !== "function" && typeof value !== "object")) {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent export is missing or invalid.");
	}

	const prototype = (value as { prototype?: unknown }).prototype;
	if (!prototype || typeof prototype !== "object") {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent.prototype is missing.");
	}

	const candidate = prototype as Record<string, unknown>;
	const missingMethods = ["updateContent", "setHideThinkingBlock", "setHiddenThinkingLabel"].filter((name) => typeof candidate[name] !== "function");
	if (missingMethods.length > 0) {
		throw new Error(`Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible (missing ${missingMethods.join(", ")}).`);
	}

	return value as { prototype: AssistantMessageComponentPrototype };
}

export function assertThinkingStepsTheme(value: unknown): ThinkingThemeLike {
	if (!value || typeof value !== "object") {
		throw new Error("Thinking Steps patch failed: interactive theme export is missing or invalid.");
	}

	try {
		const candidate = value as Record<string, unknown>;
		if (typeof candidate.fg !== "function" || typeof candidate.bold !== "function") {
			throw new Error("Thinking Steps patch failed: interactive theme export is incompatible.");
		}
	} catch (error) {
		if (error instanceof Error && /Theme not initialized/.test(error.message)) {
			return value as ThinkingThemeLike;
		}
		throw error;
	}

	return value as ThinkingThemeLike;
}

function hasPatchableContentContainer(value: AssistantMessageComponentPrototype): boolean {
	return Boolean(
		value.contentContainer
		&& typeof value.contentContainer.clear === "function"
		&& typeof value.contentContainer.addChild === "function"
		&& Array.isArray(value.contentContainer.children),
	);
}

export function resolvePiCodingAgentInternalModuleUrl(relativePath: string): string {
	try {
		return pathToFileURL(join(getPackageDir(), relativePath)).href;
	} catch (error) {
		throw new Error("Thinking Steps patch failed: could not resolve the host Pi package directory.", { cause: error });
	}
}

export async function importPiCodingAgentInternal<TModule>(relativePath: string): Promise<TModule> {
	const moduleUrl = resolvePiCodingAgentInternalModuleUrl(relativePath);
	try {
		return (await import(moduleUrl)) as TModule;
	} catch (error) {
		throw new Error(`Thinking Steps patch failed: could not import internal module "@earendil-works/pi-coding-agent/${relativePath}". Pi internals may have moved.`, {
			cause: error,
		});
	}
}

function hasVisibleThinking(content: ThinkingContent): boolean {
	return content.redacted === true || content.thinking.trim().length > 0;
}

function collectThinkingBlocks(message: AssistantMessage): ThinkingSourceBlock[] {
	const blocks: ThinkingSourceBlock[] = [];
	message.content.forEach((content, index) => {
		if (content.type !== "thinking") return;
		if (!hasVisibleThinking(content)) return;
		blocks.push({
			contentIndex: index,
			text: content.thinking,
			redacted: content.redacted,
		});
	});
	return blocks;
}

async function installPatch(providedTheme?: ThinkingThemeLike): Promise<() => void> {
	const { theme: rawTheme } = providedTheme === undefined
		? await importPiCodingAgentInternal<{ theme: unknown }>(PI_CODING_AGENT_INTERNAL_MODULES.theme)
		: { theme: providedTheme };

	const AssistantMessageComponent = assertPatchableAssistantMessageComponent(HostAssistantMessageComponent);
	const theme = assertThinkingStepsTheme(rawTheme);
	const prototype = AssistantMessageComponent.prototype;
	const originalUpdateContent = prototype.updateContent;
	const originalSetHideThinkingBlock = prototype.setHideThinkingBlock;
	const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel;

	const normalizeHiddenThinkingLabel = (label: string): string => label.replace(/\u2060+$/gu, "");

	const restoreOriginalMethods = (): void => {
		if (prototype.updateContent !== originalUpdateContent) {
			prototype.updateContent = originalUpdateContent;
		}
		if (prototype.setHideThinkingBlock !== originalSetHideThinkingBlock) {
			prototype.setHideThinkingBlock = originalSetHideThinkingBlock;
		}
		if (prototype.setHiddenThinkingLabel !== originalSetHiddenThinkingLabel) {
			prototype.setHiddenThinkingLabel = originalSetHiddenThinkingLabel;
		}
	};

	const withOriginalInstanceMethods = <T>(instance: AssistantMessageComponentPrototype, callback: () => T): T => {
		const ownUpdateContent = Object.prototype.hasOwnProperty.call(instance, "updateContent");
		const ownSetHideThinkingBlock = Object.prototype.hasOwnProperty.call(instance, "setHideThinkingBlock");
		const ownSetHiddenThinkingLabel = Object.prototype.hasOwnProperty.call(instance, "setHiddenThinkingLabel");
		const previousUpdateContent = instance.updateContent;
		const previousSetHideThinkingBlock = instance.setHideThinkingBlock;
		const previousSetHiddenThinkingLabel = instance.setHiddenThinkingLabel;

		instance.updateContent = originalUpdateContent;
		instance.setHideThinkingBlock = originalSetHideThinkingBlock;
		instance.setHiddenThinkingLabel = originalSetHiddenThinkingLabel;

		try {
			return callback();
		} finally {
			if (ownUpdateContent) {
				instance.updateContent = previousUpdateContent;
			} else {
				delete (instance as unknown as Record<string, unknown>).updateContent;
			}

			if (ownSetHideThinkingBlock) {
				instance.setHideThinkingBlock = previousSetHideThinkingBlock;
			} else {
				delete (instance as unknown as Record<string, unknown>).setHideThinkingBlock;
			}

			if (ownSetHiddenThinkingLabel) {
				instance.setHiddenThinkingLabel = previousSetHiddenThinkingLabel;
			} else {
				delete (instance as unknown as Record<string, unknown>).setHiddenThinkingLabel;
			}
		}
	};

	const reportFallback = (stage: string, error: unknown): void => {
		console.warn(`Thinking Steps patch warning: falling back to Pi renderer during ${stage}.`, error);
	};

	const fallbackErrorMessage = "Thinking Steps patch failed: Pi internals are incompatible and fallback rendering also failed.";

	const fallbackToOriginalUpdateContent = (
		instance: AssistantMessageComponentPrototype,
		message: AssistantMessage,
		stage: string,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalUpdateContent.call(instance, message);
			});
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback(stage, originalError);
		}
	};

	const fallbackToOriginalSetHideThinkingBlock = (
		instance: AssistantMessageComponentPrototype,
		hide: boolean,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHideThinkingBlock.call(instance, hide);
			});
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback("setHideThinkingBlock", originalError);
		}
	};

	const fallbackToOriginalSetHiddenThinkingLabel = (
		instance: AssistantMessageComponentPrototype,
		label: string,
		originalError?: unknown,
	): void => {
		const normalizedLabel = normalizeHiddenThinkingLabel(label);
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHiddenThinkingLabel.call(instance, normalizedLabel);
			});
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback("setHiddenThinkingLabel", originalError);
		}
	};

	const patchedUpdateContent = function patchedUpdateContent(
		this: AssistantMessageComponentPrototype,
		message: AssistantMessage,
		isStreaming = this.isStreaming,
	): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalUpdateContent(this, message, "updateContent");
			return;
		}

		try {
			// Pi owns text, Markdown reuse, transformer context, and error rendering.
			// Both the 1.4 boolean API and 1.5 getter API remain inside the host.
			const textMessage: AssistantMessage = {
				...message,
				content: message.content.filter((content) => content.type !== "thinking"),
			};
			try {
				originalUpdateContent.call(this, textMessage, isStreaming);
			} finally {
				this.lastMessage = message;
			}
			if (this.hideThinkingBlock && !this.hiddenThinkingLabel.trim()) return;

			const thinkingBlocks = collectThinkingBlocks(message);
			const firstThinkingIndex = thinkingBlocks[0]?.contentIndex ?? 0;
			const precedingTextCount = message.content.slice(0, firstThinkingIndex)
				.filter((content) => content.type === "text" && content.text.trim()).length;
			const children = [...this.contentContainer.children];
			// The host can load a different pi-tui copy. Markdown has a theme and
			// setText; native Spacer and error Text children do not have both.
			const textIndices = children.flatMap((child, index) =>
				"theme" in child && "setText" in child && typeof child.setText === "function" ? [index] : []);
			const expectedTextCount = textMessage.content.filter((content) => content.type === "text" && content.text.trim()).length;
			if (textIndices.length !== expectedTextCount) {
				throw new Error("Thinking Steps patch failed: Pi text component layout changed.");
			}
			const nextTextIndex = textIndices[precedingTextCount];
			const lastTextIndex = textIndices.at(-1);
			const insertionIndex = nextTextIndex ?? (lastTextIndex === undefined ? 0 : lastTextIndex + 1);
			const panel: Component[] = [];
			if (textIndices.length === 0) panel.push(new Spacer(1));
			panel.push(new ThinkingStepsComponent(theme, message.timestamp, thinkingBlocks, resolveThinkingMessageScope(message), this.outputPad, isStreaming));
			if (nextTextIndex !== undefined) panel.push(new Spacer(1));
			children.splice(insertionIndex, 0, ...panel);
			this.contentContainer.clear();
			for (const child of children) this.contentContainer.addChild(child);
		} catch (error) {
			fallbackToOriginalUpdateContent(this, message, "updateContent", error);
		}
	};

	const patchedSetHideThinkingBlock = function patchedSetHideThinkingBlock(this: AssistantMessageComponentPrototype, hide: boolean): void {
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHideThinkingBlock(this, hide);
			return;
		}

		// Keep the three-mode panel visible unless hiding has an explicitly empty label.
		this.hideThinkingBlock = hide && !this.hiddenThinkingLabel.trim();
		if (!this.lastMessage) return;
		try {
			this.updateContent(this.lastMessage);
		} catch (error) {
			fallbackToOriginalSetHideThinkingBlock(this, hide, error);
		}
	};

	const patchedSetHiddenThinkingLabel = function patchedSetHiddenThinkingLabel(
		this: AssistantMessageComponentPrototype,
		label: string,
	): void {
		const normalizedLabel = normalizeHiddenThinkingLabel(label);
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel);
			return;
		}

		this.hiddenThinkingLabel = normalizedLabel;
		if (!this.lastMessage) return;
		try {
			this.updateContent(this.lastMessage);
		} catch (error) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel, error);
		}
	};

	try {
		prototype.updateContent = patchedUpdateContent;
		prototype.setHideThinkingBlock = patchedSetHideThinkingBlock;
		prototype.setHiddenThinkingLabel = patchedSetHiddenThinkingLabel;
	} catch (error) {
		try {
			restoreOriginalMethods();
		} catch (rollbackError) {
			throw new Error("Thinking Steps patch failed: AssistantMessageComponent prototype patching failed and rollback was incomplete.", {
				cause: { installError: error, rollbackError },
			});
		}

		throw new Error("Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible with thinking-steps patching.", { cause: error });
	}

	return () => {
		restoreOriginalMethods();
	};
}

export async function retainThinkingStepsPatch(theme?: ThinkingThemeLike): Promise<() => Promise<void>> {
	incrementPatchRefCount();
	let cleanup = getPatchCleanup();
	if (!cleanup) {
		const existingInstallPromise = getPatchInstallPromise();
		const installPromise = existingInstallPromise ?? installPatch(theme);
		if (!existingInstallPromise) {
			setPatchInstallPromise(installPromise);
		}

		try {
			cleanup = await installPromise;
			if (!getPatchCleanup()) {
				setPatchCleanup(cleanup);
			}
		} catch (error) {
			decrementPatchRefCount();
			throw error;
		} finally {
			if (getPatchInstallPromise() === installPromise) {
				setPatchInstallPromise(undefined);
			}
		}
	}

	let released = false;
	return async () => {
		if (released) return;

		const refCount = decrementPatchRefCount();
		if (refCount > 0) {
			released = true;
			return;
		}

		const currentCleanup = getPatchCleanup();
		if (!currentCleanup) {
			released = true;
			return;
		}

		if (getPatchCleanup() === currentCleanup) {
			setPatchCleanup(undefined);
		}

		try {
			await currentCleanup();
			released = true;
		} catch (error) {
			incrementPatchRefCount();
			if (!getPatchCleanup()) {
				setPatchCleanup(currentCleanup);
			}
			throw error;
		}
	};
}
