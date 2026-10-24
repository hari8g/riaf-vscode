/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Default npm scope prefixes indexed for org-extension impact analysis. */
export const DEFAULT_ORG_EXTENSION_NPM_SCOPES = ['@mobilitystore', '@bosch'] as const;

/** Relative workspace paths scanned for Spring Cloud Config server YAML. */
export const DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS = [
	'staas-cloud-config-service-dev',
	'cloud-config',
	'config-service',
	'config-server',
] as const;

export type OrgExtensionIndexerOptions = {
	npmScopes?: readonly string[];
	configServerDirs?: readonly string[];
};

export const resolveOrgExtensionIndexerOptions = (
	options?: OrgExtensionIndexerOptions,
): Required<OrgExtensionIndexerOptions> => ({
	npmScopes: options?.npmScopes?.length ? [...options.npmScopes] : [...DEFAULT_ORG_EXTENSION_NPM_SCOPES],
	configServerDirs: options?.configServerDirs?.length ? [...options.configServerDirs] : [...DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS],
});
