import { registerSkill } from "@triliumnext/core/src/services/llm/skills.js";
import type { ToolRegistry } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";
import fs from "fs";
import path from "path";

import { RESOURCE_DIR } from "../resource_dir.js";

/**
 * Loads the Caius tool registry for `registerToolRegistryLoader`, and once it has loaded, offers
 * the `caius` skill sheet, so the skill is listed only where the tools exist. It never throws: a
 * failure to import or build the registry logs a warning and yields an empty one, so Trilium,
 * `/mcp` and the other tools keep working without Caius.
 */
export async function loadCaiusTools(
    importTools: () => Promise<{ caiusTools: ToolRegistry }> = () => import("./tools.js")
): Promise<ToolRegistry> {
    try {
        const { caiusTools } = await importTools();
        registerCaiusSkill();
        return caiusTools;
    } catch (e) {
        console.warn(`Caius disabled: ${e instanceof Error ? e.message : String(e)}`);
        const { defineTools } = await import("@triliumnext/core/src/services/llm/tools/tool_registry.js");
        return defineTools({});
    }
}

/**
 * Offers the `caius` skill sheet through `load_skill`. The sheet teaches the `caius_*` tools, so
 * `loadCaiusTools` registers it when they load, and core's catalog, which the standalone build
 * also serves, does not carry it. Returns the function that removes it again.
 */
export function registerCaiusSkill(readSheet: () => string | null = readCaiusSheet): () => void {
    return registerSkill({
        name: "caius",
        description: "Planning with Caius — the Journal's day, week and month notes, the cascade, capacity, daily planning and shutdown, the Wind down and Plan my day conversations (openers such as \"Wind down 2026-11-06\" and \"Plan my day 2026-11-09\"), and how to use the caius_* tools.",
        summary: "planning with the Caius tools (day, week and month notes, capacity, daily planning and shutdown, Wind down and Plan my day)",
        read: readSheet
    });
}

function readCaiusSheet(): string | null {
    try {
        return fs.readFileSync(path.join(RESOURCE_DIR, "llm", "caius", "skill.md"), "utf-8");
    } catch {
        return null;
    }
}
