import "./ModelSelection.css";

import type { LlmModelInfo } from "@triliumnext/commons";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

import { t } from "../../../../services/i18n";
import { fetchProviderModels, type ProviderModelsQuery } from "../../../../services/llm_chat";
import { formatModelCost } from "../../../../services/llm_model_cost";
import FormCheckbox from "../../../react/FormCheckbox";
import NoItems from "../../../react/NoItems";

interface ModelSelectionProps {
    /** Credentials describing the provider whose models should be listed. */
    query: ProviderModelsQuery;
    /** How long the fetch can take, when the provider needs longer than the default. */
    timeoutMs?: number;
    /** Currently selected models (full metadata), controlled by the parent. */
    selected: LlmModelInfo[];
    onChange: (selected: LlmModelInfo[]) => void;
    /**
     * When true, pre-select the non-legacy models on the first successful fetch
     * if nothing is selected yet — seeds a sensible default for a fresh provider.
     */
    autoSelectDefaults?: boolean;
    /**
     * Setup guidance shown alongside a listing failure. A failed fetch is the
     * moment the user needs it, so the provider passes its checklist here rather
     * than crowding the connection form with instructions nobody reads.
     */
    troubleshooting?: ComponentChildren;
}

/**
 * Fetches a provider's live model list and lets the user pick which models to
 * keep. The picked set (with full metadata) is what the chat picker later shows,
 * so no live fetch is needed during normal chatting.
 */
export default function ModelSelection({ query, timeoutMs, selected, onChange, autoSelectDefaults, troubleshooting }: ModelSelectionProps) {
    const [models, setModels] = useState<LlmModelInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | undefined>();

    // Refetch whenever the provider credentials change. A stale-guard flag drops
    // the result of a superseded request so a slow earlier fetch can't overwrite
    // a newer one.
    useEffect(() => {
        let active = true;
        setLoading(true);
        setError(undefined);
        fetchProviderModels(query, timeoutMs)
            .then(fetched => {
                if (!active) return;
                setModels(fetched);
                setLoading(false);
                const seedFresh = autoSelectDefaults && selected.length === 0;
                // A stored selection the listing no longer carries any part of is one the provider
                // has moved on from, so it is seeded again as for a new provider: the old ids are
                // ones the provider now refuses, so keeping them would offer nothing usable.
                const seedSuperseded = selected.length > 0
                    && !selected.some(model => fetched.some(f => f.id === model.id));
                if ((seedFresh || seedSuperseded) && fetched.length > 0) {
                    onChange(defaultSelectedModels(fetched));
                    return;
                }
                const refreshed = refreshSelectedModels(selected, fetched);
                if (refreshed) {
                    onChange(refreshed);
                }
            })
            .catch(err => {
                if (!active) return;
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            });
        return () => { active = false; };
        // selected/onChange intentionally excluded: refetch tracks credentials only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query.provider, query.apiKey, query.baseURL]);

    const isSelected = useCallback((model: LlmModelInfo) => selected.some(s => s.id === model.id), [selected]);

    const defaultId = defaultModelId(selected);

    const toggle = useCallback((model: LlmModelInfo, checked: boolean) => {
        onChange(checked
            ? [...selected, keepDefault(model, defaultId)]
            : selected.filter(s => s.id !== model.id));
    }, [selected, onChange, defaultId]);

    const makeDefault = useCallback((id: string) => {
        onChange(selected.map(model => ({ ...model, isDefault: model.id === id })));
    }, [selected, onChange]);

    if (loading) {
        return <div className="model-selection-status">{t("llm.models_loading")}</div>;
    }
    if (error) {
        return (
            // JSX escapes the text itself, so i18next must not escape the message as well.
            <NoItems
                icon="bx bx-error-circle"
                className="model-selection-error"
                text={t("llm.models_load_failed", { error, interpolation: { escapeValue: false } })}
            >
                {troubleshooting}
            </NoItems>
        );
    }
    if (models.length === 0) {
        return <NoItems icon="bx bx-bot" text={t("llm.models_none_available")}>{troubleshooting}</NoItems>;
    }

    const allSelected = models.every(isSelected);

    return (
        <div className="model-selection">
            <div className="model-selection-toolbar">
                <span className="model-selection-count">{t("llm.models_selected_count", { count: selected.length, total: models.length })}</span>
                <div className="model-selection-actions">
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => onChange(defaultSelectedModels(models))}>
                        {t("llm.models_reset_defaults")}
                    </button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => onChange(allSelected ? [] : models.map(model => selected.find(s => s.id === model.id) ?? keepDefault(model, defaultId)))}>
                        {allSelected ? t("llm.models_select_none") : t("llm.models_select_all")}
                    </button>
                </div>
            </div>
            <div className="model-selection-list scroll-edge-fade">
                {models.map(model => (
                    <div key={model.id} className="model-selection-row">
                        <FormCheckbox
                            name={`model-${model.id}`}
                            currentValue={isSelected(model)}
                            onChange={checked => toggle(model, checked)}
                            label={<ModelLabel model={model} />}
                        />
                        {model.id === defaultId
                            ? <span className="model-selection-default">{t("llm.models_default")}</span>
                            : isSelected(model) && (
                                <button type="button" className="model-selection-make-default" onClick={() => makeDefault(model.id)}>
                                    {t("llm.models_make_default")}
                                </button>
                            )}
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * The models pre-selected by default (fresh provider, or "Reset to defaults").
 * The recommendation rule lives on the server (see isRecommendedByDefault); the
 * client just honours the `recommended` flag it tags each model with.
 */
function defaultSelectedModels(models: LlmModelInfo[]): LlmModelInfo[] {
    return models.filter(model => model.recommended);
}

/**
 * The model a new chat starts on: the first selected one marked default, else the first selected —
 * the same rule the chat applies (useLlmChat), so the row marked "Default" is the one it opens with.
 */
function defaultModelId(selected: LlmModelInfo[]): string | undefined {
    return (selected.find(model => model.isDefault) ?? selected[0])?.id;
}

/**
 * The selection with each stored model replaced by its listed entry, so saving the provider picks
 * up new metadata such as `reasoningEfforts`, a changed price or an improved name. A model the
 * listing no longer carries stays as stored. Once the user has a default, each model keeps its
 * stored `isDefault`, so the listing's own default flag does not move it. Returns undefined when
 * nothing changed.
 */
function refreshSelectedModels(selected: LlmModelInfo[], fetched: LlmModelInfo[]): LlmModelInfo[] | undefined {
    const listed = new Map(fetched.map(model => [model.id, model]));
    const hasChosenDefault = selected.some(model => model.isDefault);
    const refreshed = selected.map(model => {
        const entry = listed.get(model.id);
        if (!entry) return model;
        return hasChosenDefault ? { ...entry, isDefault: model.isDefault } : entry;
    });
    return JSON.stringify(refreshed) === JSON.stringify(selected) ? undefined : refreshed;
}

/**
 * A model being added to the selection, without the server's own default flag when the user already
 * has a default: picking Opus as well must not move the default off the model they chose.
 */
function keepDefault(model: LlmModelInfo, defaultId: string | undefined): LlmModelInfo {
    return model.isDefault && defaultId !== undefined && defaultId !== model.id ? { ...model, isDefault: false } : model;
}

/** Row label: model name plus a cost hint (per-Mtok price / subscription) when known. */
function ModelLabel({ model }: { model: LlmModelInfo }) {
    const cost = formatModelCost(model);
    return (
        <span className="model-selection-label">
            <span className="model-selection-name">{model.name}</span>
            {cost && <small className="model-selection-cost">({cost})</small>}
        </span>
    );
}
