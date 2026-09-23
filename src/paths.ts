/**
 * Path resolution for pi-marketplaces.
 *
 * Maps logical locations (e.g. global agents, project skills) to concrete
 * filesystem paths within the project or the global Pi installation.
 *
 * Pi's standard locations are discovered rather than hard-coded:
 * - global: `~/.pi/agent/agents` (agents), `~/.pi/agent/skills` (skills)
 * - project: `.pi/agents`, `.pi/skills`
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const GLOBAL_PI_DIR = process.env.PI_CODING_AGENT_DIR || process.env.HOME + "/.pi/agent";
export const GLOBAL_AGENTS_DIR = GLOBAL_PI_DIR + "/agents";
export const GLOBAL_SKILLS_DIR = GLOBAL_PI_DIR + "/skills";

export const PROJECT_AGENTS_DIR = CONFIG_DIR_NAME + "/agents";
export const PROJECT_SKILLS_DIR = CONFIG_DIR_NAME + "/skills";

export const GLOBAL_MARKETPLACE_DIR = GLOBAL_PI_DIR + "/marketplaces";
export const GLOBAL_STATE_FILE = GLOBAL_PI_DIR + "/marketplaces-state.json";