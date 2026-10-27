/**
 * The tool that hands a skill sheet to the model. Only the names and
 * descriptions travel in the tool listing; the sheet itself is fetched here, so
 * the system prompt stays small.
 */

import { z } from "zod";

import { listSkills, readSkill } from "../skills.js";
import { defineTools } from "./tool_registry.js";

export const skillTools = defineTools({
    load_skill: {
        // A getter, because a host can register a skill after this module loads.
        get description() {
            return `Load a skill to get specialized instructions. Available skills:\n${
                listSkills().map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
        },
        inputSchema: z.object({
            name: z.string().describe("The skill name to load")
        }),
        execute: ({ name }) => {
            const instructions = readSkill(name);
            if (!instructions) {
                return { error: `Unknown skill: '${name}'. Available: ${listSkills().map((s) => s.name).join(", ")}` };
            }
            return { skill: name, instructions };
        }
    }
});
