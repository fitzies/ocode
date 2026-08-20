export type PiCatalogItemKind = "skill" | "extension";

export interface PiCatalogItem {
  kind: PiCatalogItemKind;
  id: string;
  name: string;
  description?: string;
  path: string;
  modifiedAt: string;
}

export interface PiResourceContent {
  item: PiCatalogItem;
  text: string;
  etag: string;
}

export interface PiCatalog {
  skillsRoot: string;
  extensionsRoot: string;
  skills: PiCatalogItem[];
  extensions: PiCatalogItem[];
}
