import type { ToolRegistry } from "@triliumnext/core/src/services/llm/tools/tool_registry.js";

/**
 * Loads the Caius tool registry for `registerToolRegistryLoader`. It never throws: a failure to
 * import or build the registry logs a warning and yields an empty one, so Trilium, `/mcp` and the
 * other tools keep working without Caius.
 */
export async function loadCaiusTools(
    importTools: () => Promise<{ caiusTools: ToolRegistry }> = () => import("./tools.js")
): Promise<ToolRegistry> {
    try {
        return (await importTools()).caiusTools;
    } catch (e) {
        console.warn(`Caius disabled: ${e instanceof Error ? e.message : String(e)}`);
        const { defineTools } = await import("@triliumnext/core/src/services/llm/tools/tool_registry.js");
        return defineTools({});
    }
}
