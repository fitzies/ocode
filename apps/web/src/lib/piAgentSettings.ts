import type { ModelDescriptor, PiAgentDefinition, PiAgentSettings, PiModelAlias } from '@anvil/protocol';
import { useEffect, useState } from 'react';

const configuredTransport = import.meta.env.VITE_OCODE_TRANSPORT ?? import.meta.env.VITE_ANVIL_TRANSPORT;
const fixtures = configuredTransport === 'fixture' || (import.meta.env.DEV && configuredTransport !== 'forge');
const changedEvent = 'ocode-model-aliases-changed';
const fixtureSettings: PiAgentSettings = {
  agents: ['scout', 'builder', 'reviewer', 'researcher'].map(name => ({
    id: `${name}.md`, name, description: `The ${name} role for your coding tasks.`,
    model: 'openai-codex/gpt-5.6', thinking: 'high',
    text: `You are a ${name} agent. Follow the repository instructions and report your findings clearly.`, etag: `fixture-${name}-0`,
  })),
  models: [{ alias: 'GPT-5.6', modelId: 'openai-codex/gpt-5.6' }], modelsEtag: 'fixture-models-0',
};

export class AgentSettingsError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/pi/agent-settings${path}`, value === undefined
    ? { cache: 'no-store' }
    : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw new AgentSettingsError(data?.message ?? 'Forge could not load or save these settings.', response.status);
  return data as T;
}
export async function loadAgentSettings(): Promise<PiAgentSettings> {
  return fixtures ? structuredClone(fixtureSettings) : request('');
}
export async function saveAgentDefinition(agent: PiAgentDefinition): Promise<PiAgentDefinition> {
  if (!fixtures) return request('/agent', agent);
  const index = fixtureSettings.agents.findIndex(item => item.id === agent.id);
  if (index < 0 || fixtureSettings.agents[index].etag !== agent.etag) throw new AgentSettingsError('Agent changed. Reload before saving.', 409);
  const next = { ...agent, etag: `${agent.etag}-saved` };
  fixtureSettings.agents[index] = next;
  return structuredClone(next);
}
export async function loadModelAliases(): Promise<{ models: PiModelAlias[]; etag: string }> {
  return fixtures ? { models: structuredClone(fixtureSettings.models), etag: fixtureSettings.modelsEtag } : request('/models');
}
export async function saveModelAliases(models: PiModelAlias[], etag: string): Promise<{ models: PiModelAlias[]; etag: string }> {
  let result: { models: PiModelAlias[]; etag: string };
  if (fixtures) {
    if (etag !== fixtureSettings.modelsEtag) throw new AgentSettingsError('Models changed. Reload before saving.', 409);
    fixtureSettings.models = structuredClone(models);
    fixtureSettings.modelsEtag += '-saved';
    result = { models, etag: fixtureSettings.modelsEtag };
  } else result = await request('/models', { models, etag });
  window.dispatchEvent(new Event(changedEvent));
  return result;
}
export function useModelAliases(): PiModelAlias[] {
  const [models, setModels] = useState<PiModelAlias[]>([]);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void loadModelAliases().then(data => {
        if (!disposed && current === generation) setModels(data.models);
      }).catch(() => { /* Pi's available models remain usable if settings are unavailable. */ });
    };
    refresh();
    window.addEventListener(changedEvent, refresh);
    window.addEventListener('focus', refresh);
    return () => { disposed = true; window.removeEventListener(changedEvent, refresh); window.removeEventListener('focus', refresh); };
  }, []);
  return models;
}
/** Never advertise a model that Pi cannot use; keep the active choice visible. */
export function configuredModels(available: ModelDescriptor[], aliases: PiModelAlias[], currentId?: string): ModelDescriptor[] {
  if (!aliases.length) return available;
  const selected = aliases.flatMap(alias => {
    const model = available.find(item => item.id === alias.modelId);
    return model ? [{ ...model, name: alias.alias }] : [];
  });
  const current = available.find(item => item.id === currentId);
  if (current && !selected.some(item => item.id === current.id)) selected.push(current);
  return selected;
}
export function modelAliasError(models: PiModelAlias[]): string | undefined {
  const aliases = new Set<string>();
  const ids = new Set<string>();
  for (const model of models) {
    if (!model.alias.trim() || !model.modelId.trim()) return 'Enter an alias and model ID for every row.';
    if (/\s/.test(model.modelId)) return 'Model IDs cannot contain whitespace.';
    const alias = model.alias.trim().toLowerCase();
    if (aliases.has(alias) || ids.has(model.modelId)) return 'Each alias and model ID must be unique.';
    aliases.add(alias); ids.add(model.modelId);
  }
}
