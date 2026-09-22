import type { ModelDescriptor } from '@anvil/protocol';
import { describe, expect, it } from 'vitest';

import { configuredModels, modelAliasError } from './piAgentSettings';

const model = (id: string, name: string): ModelDescriptor => ({
  id,
  name,
  provider: 'openai-codex',
  reasoning: true,
  input: ['text'],
  supportedThinkingLevels: ['low', 'medium', 'high'],
});

describe('configuredModels', () => {
  it('returns every Pi model when no aliases are saved', () => {
    const available = [model('openai/gpt-5.4', 'Sol'), model('custom/latest', 'Custom')];
    expect(configuredModels(available, [])).toEqual(available);
  });

  it('shows saved aliases with Pi names replaced, skipping unavailable models', () => {
    const available = [model('openai-codex/gpt-5.6', 'GPT-5.6')];
    const selected = configuredModels(available, [
      { alias: 'Coding', modelId: 'openai-codex/gpt-5.6' },
      { alias: 'Missing', modelId: 'unknown/model' },
    ]);
    expect(selected).toEqual([{ ...available[0], name: 'Coding' }]);
  });

  it('keeps Pi reasoning options and the active model visible', () => {
    const current = model('custom/latest', 'Custom');
    const selected = configuredModels([model('openai-codex/gpt-5.6', 'GPT-5.6'), current], [
      { alias: 'Coding', modelId: 'openai-codex/gpt-5.6' },
    ], 'custom/latest');
    expect(selected.map(item => item.id)).toEqual(['openai-codex/gpt-5.6', 'custom/latest']);
    expect(selected[0]!.supportedThinkingLevels).toEqual(['low', 'medium', 'high']);
    expect(selected[1]!.name).toBe('Custom');
  });
});

describe('modelAliasError', () => {
  it('requires an alias and model ID per row with unique values', () => {
    expect(modelAliasError([{ alias: '', modelId: 'a/b' }])).toContain('alias and model ID');
    expect(modelAliasError([{ alias: 'A', modelId: 'a b' }])).toContain('whitespace');
    expect(modelAliasError([
      { alias: 'A', modelId: 'a/b' },
      { alias: 'a', modelId: 'c/d' },
    ])).toContain('unique');
    expect(modelAliasError([{ alias: 'A', modelId: 'a/b' }])).toBeUndefined();
  });
});
