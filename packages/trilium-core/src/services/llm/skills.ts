/**
 * The skill sheets: instruction sets an LLM loads on demand when a question
 * needs knowledge the system prompt has no room for (search syntax, the
 * scripting APIs, how a dashboard is put together).
 *
 * The sheets themselves are markdown under `src/assets/llm/skills`, and how a
 * host gets at them differs by runtime — the server reads them off disk, the
 * browser build has them inlined by its bundler — so this module carries only
 * the catalog and the seam. Kept apart from {@link ../tools/skill_tools.js} so
 * that registering a reader costs a host nothing but this file: the tool module
 * reaches the AI SDK through the tool registry, which the standalone build goes
 * to some length to keep out of its startup path.
 */

export interface SkillDefinition {
    name: string;
    /** Long description shown in the load_skill tool's listing. */
    description: string;
    /** Short noun phrase for inline use in the system prompt. */
    summary: string;
    /** Markdown file under `src/assets/llm/skills`, which is what a reader is asked for. */
    file: string;
}

export const SKILLS: SkillDefinition[] = [
    {
        name: "search_syntax",
        description: "Trilium search query syntax reference — labels, relations, note properties, boolean logic, ordering, and more.",
        summary: "Trilium search query syntax",
        file: "search_syntax.md"
    },
    {
        name: "backend_scripting",
        description: "Backend (Node.js) scripting API — creating notes, handling events, accessing entities, database operations, and automation.",
        summary: "the backend Node.js scripting API",
        file: "backend_scripting.md"
    },
    {
        name: "frontend_scripting",
        description: "Frontend (browser) scripting API — UI widgets, navigation, dialogs, editor access, Preact/JSX components, and keyboard shortcuts.",
        summary: "the frontend browser scripting API",
        file: "frontend_scripting.md"
    },
    {
        name: "dashboards",
        description: "Dashboard collections — creating a dashboard note, adding widgets (text, diagrams, web views), and building interactive widgets with Preact render notes.",
        summary: "creating dashboard collections and their widgets",
        file: "dashboards.md"
    }
];

/** Host-provided reader for the sheets. See {@link registerSkillReader}. */
let skillReader: ((file: string) => string | null) | null = null;

/**
 * Register the host's reader for skill sheets, keyed by the file name in
 * {@link SKILLS}.
 *
 * Must answer synchronously, because a tool's `execute` does — so a host that
 * cannot read on demand (no filesystem) inlines or preloads the sheets and
 * answers from memory.
 */
export function registerSkillReader(reader: (file: string) => string | null) {
    skillReader = reader;
}

/** A sheet a host contributes at runtime, with its own way of producing the markdown. */
type HostSkill = Omit<SkillDefinition, "file"> & { read: () => string | null };

const hostSkills = new Map<string, HostSkill>();

/**
 * Add a skill that only some hosts have, such as one that teaches tools the
 * browser build does not carry. The catalog in {@link SKILLS} stays what every
 * host serves; this adds to what {@link listSkills} and {@link readSkill}
 * report, so the `load_skill` listing and the system prompt name the skill only
 * where it was registered.
 *
 * `read` has the same contract as the reader of {@link registerSkillReader}:
 * synchronous, null when the sheet cannot be produced. A name already in
 * {@link SKILLS} is refused, and registering a name again replaces it. Returns
 * a function that removes the skill again.
 */
export function registerSkill(skill: HostSkill): () => void {
    if (SKILLS.some((s) => s.name === skill.name)) {
        throw new Error(`Skill '${skill.name}' is already in the core catalog`);
    }
    hostSkills.set(skill.name, skill);
    return () => {
        if (hostSkills.get(skill.name) === skill) {
            hostSkills.delete(skill.name);
        }
    };
}

/** Every skill this host serves: the core catalog, then what the host registered. */
export function listSkills(): Pick<SkillDefinition, "name" | "description" | "summary">[] {
    return [...SKILLS, ...hostSkills.values()];
}

/**
 * The sheet's markdown, or null when the skill is unknown to the catalog or the
 * host cannot produce it.
 */
export function readSkill(name: string): string | null {
    const hosted = hostSkills.get(name);
    if (hosted) {
        return hosted.read();
    }
    const skill = SKILLS.find((s) => s.name === name);
    if (!skill || !skillReader) {
        return null;
    }
    return skillReader(skill.file);
}

/**
 * Returns an inline-prose summary of available skills for the system prompt.
 * Deliberately NOT a bulleted list — bullets with `- name: description` look
 * like a tool catalog to some models (notably Gemini), which then hallucinate
 * calls to the skill names as if they were tools.
 */
export function getSkillsSummary(): string {
    return listSkills().map((s) => `"${s.name}" for ${s.summary}`).join(", ");
}
