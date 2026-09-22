export interface PiAgentDefinition {
  id: string;
  name: string;
  description: string;
  model: string;
  thinking: string;
  text: string;
  etag: string;
}

export interface PiModelAlias {
  alias: string;
  modelId: string;
}

export interface PiModelAliasSettings {
  models: PiModelAlias[];
  etag: string;
}

export interface PiAgentSettings {
  agents: PiAgentDefinition[];
  models: PiModelAlias[];
  modelsEtag: string;
}
