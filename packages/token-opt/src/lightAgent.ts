/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ChatMode, GlobalSettings } from './types.js';

/** Smaller directory tree budget when light agent is on. */
export const LIGHT_AGENT_MAX_DIRSTR_CHARS = 6_000;

export const isLightAgentEnabled = (settings: GlobalSettings): boolean => {
	return settings.enableLightAgent === true;
};

export const shouldGenerateAgentPlan = (settings: GlobalSettings): boolean => {
	return settings.enableAgentPlan && !isLightAgentEnabled(settings);
};

export const shouldUseParallelReadBatching = (settings: GlobalSettings): boolean => {
	return settings.enableParallelReadBatching && !isLightAgentEnabled(settings);
};

/** Use the smaller repo-profile cap (normal mode) while still in agent chat mode. */
export const getEffectiveRepoProfileMode = (chatMode: ChatMode, settings: GlobalSettings): ChatMode => {
	if (isLightAgentEnabled(settings) && chatMode === 'agent') {
		return 'normal';
	}
	return chatMode;
};

export const getEffectiveMaxReadOnlyCalls = (settings: GlobalSettings): number => {
	const configured = settings.maxReadOnlyCalls;
	if (isLightAgentEnabled(settings)) {
		return Math.min(configured, 6);
	}
	return configured;
};
