import type { PiAgentDefinition, PiAgentSettings, PiModelAlias } from '@anvil/protocol';
import { Add01Icon, ArrowLeft02Icon, Delete02Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AgentSettingsError, loadAgentSettings, modelAliasError, saveAgentDefinition, saveModelAliases } from '@/lib/piAgentSettings';

const REASONING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function AgentEditor({ agent, models, onChange }: {
  agent: PiAgentDefinition; models: PiModelAlias[]; onChange: (patch: Partial<PiAgentDefinition>) => void;
}) {
  return <div className="mx-auto grid w-full max-w-3xl gap-5 p-5 sm:p-8">
    <div className="flex items-center justify-between gap-3">
      <div><p className="mb-1 text-[0.625rem] tracking-widest text-muted-foreground">SUBAGENT</p><h2 className="font-mono text-lg font-medium">{agent.name}</h2></div>
      <Badge variant="outline">Global</Badge>
    </div>
    <Field><FieldLabel htmlFor="agent-name">Name</FieldLabel><Input id="agent-name" value={agent.name} maxLength={64} onChange={event => onChange({ name: event.target.value })}/></Field>
    <Field><FieldLabel htmlFor="agent-description">Description</FieldLabel><Input id="agent-description" value={agent.description} maxLength={2000} onChange={event => onChange({ description: event.target.value })}/><p className="text-xs text-muted-foreground">Helps Pi decide when to use this subagent.</p></Field>
    <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_140px]">
      <Field><FieldLabel htmlFor="agent-model">Model ID</FieldLabel><Input id="agent-model" value={agent.model} placeholder="Inherit parent model" onChange={event => onChange({ model: event.target.value })}/>
        {models.length > 0 && <Select value={models.some(model => model.modelId === agent.model) ? agent.model : ''} onValueChange={model => onChange({ model })}>
          <SelectTrigger className="w-full" aria-label="Choose a saved model"><SelectValue placeholder="Choose a saved model"/></SelectTrigger>
          <SelectContent>{models.map(model => <SelectItem key={model.modelId} value={model.modelId}>{model.alias} · {model.modelId}</SelectItem>)}</SelectContent>
        </Select>}
      </Field>
      <Field><FieldLabel htmlFor="agent-reasoning">Reasoning</FieldLabel><Select value={agent.thinking || 'inherit'} onValueChange={thinking => onChange({ thinking: thinking === 'inherit' ? '' : thinking })}>
        <SelectTrigger id="agent-reasoning" className="w-full"><SelectValue/></SelectTrigger>
        <SelectContent><SelectItem value="inherit">Inherit</SelectItem>{Array.from(new Set([...REASONING, ...(agent.thinking ? [agent.thinking] : [])])).map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectContent>
      </Select></Field>
    </div>
    <Field><div className="flex items-center justify-between"><FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel><span className="text-xs text-muted-foreground">Markdown</span></div><Textarea id="agent-instructions" value={agent.text} onChange={event => onChange({ text: event.target.value })} spellCheck={false} className="min-h-72 resize-y font-mono text-xs leading-6"/><p className="text-xs leading-relaxed text-muted-foreground">Model and reasoning must be supported by Pi. Changes apply to new subagent runs; start a new parent session to reload the Pi extension.</p></Field>
  </div>;
}

function ModelsEditor({ models, onChange }: { models: PiModelAlias[]; onChange: (models: PiModelAlias[]) => void }) {
  return <div className="mx-auto grid w-full max-w-4xl gap-6 p-5 sm:p-8">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-medium">Models & aliases</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">The models you want in the picker, with names you recognize.</p></div><Button variant="outline" disabled={models.length >= 100} onClick={() => onChange([...models, { alias: '', modelId: '' }])}><HugeiconsIcon icon={Add01Icon}/>Add model</Button></div>
    <div className="divide-y rounded-lg border px-4">{models.length ? models.map((model, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
      <Field className="col-span-2 sm:col-span-1"><FieldLabel htmlFor={`model-alias-${index}`}>Alias</FieldLabel><Input id={`model-alias-${index}`} placeholder="My coding model" value={model.alias} maxLength={80} onChange={event => onChange(models.map((item, i) => i === index ? { ...item, alias: event.target.value } : item))}/></Field>
      <Field><FieldLabel htmlFor={`model-id-${index}`}>Model ID</FieldLabel><Input id={`model-id-${index}`} placeholder="openai-codex/gpt-5.6" value={model.modelId} maxLength={300} onChange={event => onChange(models.map((item, i) => i === index ? { ...item, modelId: event.target.value } : item))}/></Field>
      <Button variant="ghost" size="icon" aria-label={`Remove ${model.alias || 'model ' + (index + 1)}`} onClick={() => onChange(models.filter((_, i) => i !== index))}><HugeiconsIcon icon={Delete02Icon}/></Button>
    </div>) : <p className="py-8 text-center text-xs text-muted-foreground">No saved models. The chat picker shows all models available in Pi.</p>}</div>
    <p className="text-xs leading-relaxed text-muted-foreground">Use the full provider/model ID. Saved models appear in chat when Pi makes them available. Aliases are display names; changing this list does not change existing subagent assignments.</p>
  </div>;
}

export function PiAgentSettingsPage() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<PiAgentSettings>();
  const [draft, setDraft] = useState<PiAgentDefinition>();
  const [models, setModels] = useState<PiModelAlias[]>([]);
  const [section, setSection] = useState('agents');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [status, setStatus] = useState('');
  const [mobileEditor, setMobileEditor] = useState(false);
  const generation = useRef(0);
  const original = settings?.agents.find(agent => agent.id === draft?.id);
  const agentDirty = Boolean(draft && original && !equal(draft, original));
  const modelsDirty = Boolean(settings && !equal(models, settings.models));
  const dirty = agentDirty || modelsDirty;
  const blocked = dirty || saving;
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(undefined);
    try {
      const next = await loadAgentSettings();
      if (current !== generation.current) return;
      setSettings(next); setModels(next.models);
      setDraft(previous => next.agents.find(agent => agent.id === previous?.id) ?? next.agents[0]);
      setUncertain(false); setStatus('');
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : 'Could not load settings.');
    } finally { if (current === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  useBlocker({
    shouldBlockFn: () => { if (blocked) toast.error('Save or discard your changes before leaving.'); return blocked; },
    enableBeforeUnload: () => blocked,
  });
  const changeSection = (value: string) => {
    if (!value || value === section) return;
    if (blocked) { toast.error('Save or discard your changes before switching sections.'); return; }
    setSection(value); setError(undefined); setStatus('');
  };
  const selectAgent = (agent: PiAgentDefinition) => {
    if (agent.id !== draft?.id && blocked) { toast.error('Save or discard your changes before switching agents.'); return; }
    setDraft(agent); setMobileEditor(true); setError(undefined); setStatus('');
  };
  const discard = () => {
    setDraft(original); setModels(settings?.models ?? []); setStatus('Changes discarded.'); setError(undefined);
    if (uncertain) void load();
  };
  const save = async () => {
    if (!settings || saving || uncertain) return;
    const validation = section === 'models' ? modelAliasError(models) : !draft?.name.trim() ? 'Enter an agent name.' : undefined;
    if (validation) { setError(validation); return; }
    setSaving(true); setError(undefined); setStatus('');
    try {
      if (section === 'agents' && draft) {
        const next = await saveAgentDefinition(draft);
        setSettings(previous => previous && { ...previous, agents: previous.agents.map(agent => agent.id === next.id ? next : agent) });
        setDraft(next);
      } else {
        const next = await saveModelAliases(models.map(model => ({ alias: model.alias.trim(), modelId: model.modelId.trim() })), settings.modelsEtag);
        setSettings(previous => previous && { ...previous, models: next.models, modelsEtag: next.etag }); setModels(next.models);
      }
      setStatus('Saved to Forge.');
    } catch (failure) {
      const requiresReload = !(failure instanceof AgentSettingsError) || failure.status === 409 || failure.status >= 500;
      setUncertain(requiresReload);
      setError((failure instanceof Error ? failure.message : 'Could not save settings.') + (requiresReload ? ' Your draft is still here. Copy it if needed, then reload to check the saved version.' : ''));
    } finally { setSaving(false); }
  };
  const filtered = settings?.agents.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <header className="session-header" data-tauri-drag-region="deep"><div className="header-title-group"><SidebarTrigger className="menu-trigger" aria-label="Toggle sidebar"/><div className="session-heading"><h1>Agents &amp; models</h1></div></div><Button variant="ghost" onClick={() => void navigate({ to: '/pi/skills' })}>Skills &amp; extensions</Button></header>
    <div className="border-b px-4 py-3 sm:px-6"><ToggleGroup type="single" value={section} onValueChange={changeSection} aria-label="Agent settings section"><ToggleGroupItem value="agents">Subagents <Badge variant="secondary">{settings?.agents.length ?? 0}</Badge></ToggleGroupItem><ToggleGroupItem value="models">Models &amp; aliases <Badge variant="secondary">{settings?.models.length ?? 0}</Badge></ToggleGroupItem></ToggleGroup></div>
    {loading ? <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><Spinner/>Loading settings</div> : !settings ? <div className="grid gap-4 p-8"><p role="alert">{error}</p><Button variant="outline" className="w-fit" onClick={() => void load()}>Retry</Button></div> : <>
      {section === 'agents' ? <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className={`${mobileEditor ? 'hidden sm:flex' : 'flex'} min-h-0 w-full flex-col gap-4 border-r p-4 sm:w-60 sm:shrink-0`} aria-label="Subagents">
          <InputGroup><InputGroupAddon><HugeiconsIcon icon={Search01Icon}/></InputGroupAddon><InputGroupInput aria-label="Search subagents" placeholder="Search subagents…" value={query} onChange={event => setQuery(event.target.value)}/></InputGroup>
          <ScrollArea className="min-h-0 flex-1"><div className="grid gap-1">{filtered.map(agent => <Button key={agent.id} variant={agent.id === draft?.id ? 'secondary' : 'ghost'} className="h-auto w-full justify-start gap-3 px-3 py-3 text-left" onClick={() => selectAgent(agent)} aria-current={agent.id === draft?.id ? 'true' : undefined}><span className="flex size-7 shrink-0 items-center justify-center rounded-md border font-mono text-xs" aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</span><span className="grid min-w-0 gap-1"><span className="truncate font-medium">{agent.name}</span><span className="truncate text-[0.625rem] font-normal text-muted-foreground">{settings.models.find(model => model.modelId === agent.model)?.alias ?? agent.model.split('/').at(-1) ?? 'Inherit model'}</span></span></Button>)}</div>{!filtered.length && <p className="py-4 text-xs text-muted-foreground">{settings.agents.length ? 'No matching subagents.' : 'No subagents found in the Pi subagents extension.'}</p>}</ScrollArea>
        </aside>
        <ScrollArea className={`${mobileEditor ? '' : 'hidden sm:block'} min-h-0 flex-1`}>
          <Button variant="ghost" className="ml-4 mt-3 sm:hidden" onClick={() => setMobileEditor(false)}><HugeiconsIcon icon={ArrowLeft02Icon}/>Subagents</Button>
          {draft ? <fieldset disabled={saving} className="min-w-0"><AgentEditor agent={draft} models={settings.models} onChange={patch => { setDraft({ ...draft, ...patch }); setStatus(''); }}/></fieldset> : <p className="p-8 text-sm text-muted-foreground">Install the Pi subagents extension to edit its agents here.</p>}
        </ScrollArea>
      </div> : <ScrollArea className="min-h-0 flex-1"><fieldset disabled={saving} className="min-w-0"><ModelsEditor models={models} onChange={next => { setModels(next); setStatus(''); }}/></fieldset></ScrollArea>}
      <footer className="grid gap-3 border-t px-4 py-3 sm:px-6">
        {error && <div className="flex flex-wrap items-center gap-3"><p className="min-w-0 flex-1 text-xs text-destructive" role="alert">{error}</p>{uncertain && <Button variant="outline" onClick={() => void load()}>Reload saved version</Button>}</div>}
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground" role="status">{saving ? 'Saving…' : status || (dirty ? 'Unsaved changes' : 'Changes are saved on Forge.')}</span><div className="flex gap-2"><Button variant="ghost" disabled={!dirty || saving} onClick={discard}>Discard</Button><Button disabled={!dirty || saving || uncertain} onClick={() => void save()}>{saving ? <Spinner/> : <HugeiconsIcon icon={Tick02Icon}/>}Save changes</Button></div></div>
      </footer>
    </>}
  </div>;
}
