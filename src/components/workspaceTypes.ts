export type WorkspaceProject = { id: string; name: string; relativePath: string };
export type WorkspaceClientType = {
  id: string;
  name: string;
  folderTemplateId: string;
  features: string[];
  featureOptions: Record<string, string[]>;
};
export type WorkspaceProfile = {
  id: string;
  name: string;
  projectIds: string[];
  allowedClientTypeIds: string[];
  defaultClientTypeId: string;
};
export type WorkspaceFolder = { id: string; path: string; purpose: string; enabled: boolean; required: boolean };
export type WorkspaceFolderTemplate = { id: string; name: string; folders: WorkspaceFolder[] };
export type WorkspaceResource = { id: string; name: string; relativePath: string | null };
export type WorkspaceConfig = {
  schemaVersion: number;
  revision: number;
  contentHash: string;
  workspaceId: string;
  displayName: string;
  projects: WorkspaceProject[];
  projectShowNames: string[];
  clientTypes: WorkspaceClientType[];
  profiles: WorkspaceProfile[];
  folderTemplates: WorkspaceFolderTemplate[];
  resources: WorkspaceResource[];
};
export type WorkspaceDiscovery = {
  status: "valid" | "absent" | "unavailable" | "invalid" | "unsupported";
  root: string;
  config: WorkspaceConfig | null;
  writable: boolean;
  message: string | null;
  lock: { path: string; content: string; modified: string | null; canOfferRecovery: boolean } | null;
};
export type WorkspaceHistoryEntry = { fileName: string; revision: number; contentHash: string; modified: string | null };

export const WORKSPACE_FEATURES = [
  { id: "premiere_project", title: "Premiere project", description: "Create a Premiere project in the edit folder." },
  { id: "seasons", title: "Season support", description: "Organize clients by season." },
  { id: "social_project", title: "Social project", description: "Use this type for social media work." },
  { id: "reporting", title: "Reporting", description: "Use this type for analysis and reporting." },
] as const;
