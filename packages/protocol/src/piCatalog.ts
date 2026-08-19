export type PiCatalogItemKind = "skill" | "extension";

export interface PiCatalogItem {
  kind: PiCatalogItemKind;
  name: string;
  description?: string;
  path: string;
  modifiedAt: string;
}

export interface PiCatalog {
  skillsRoot: string;
  extensionsRoot: string;
  skills: PiCatalogItem[];
  extensions: PiCatalogItem[];
}
