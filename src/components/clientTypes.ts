export const CLIENT_TYPES = ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number] | "REPORT" | "CUSTOM";
const projectFolder = (root: string) => (root.split(/[\\/]/).filter(Boolean).pop() ?? "")
  .trim()
  .replace(/^\d+[\s_-]+/, "")
  .trim()
  .toLowerCase();
export const isMariyaProject = (root: string) => projectFolder(root) === "mariya meets";
export const defaultClientType = (root: string): ClientType => {
  const folder = projectFolder(root);
  if (folder === "socials") return "SOCIAL";
  if (folder === "analysis") return "REPORT";
  if (isMariyaProject(root)) return "MARIYAMEETS";
  return "EXHIBITOR";
};
export const isFixedClientTypeProject = (root: string) => ["socials", "analysis"].includes(projectFolder(root));
export const availableClientTypes = (root: string): readonly ClientType[] => {
  const folder = projectFolder(root);
  if (folder === "socials") return ["SOCIAL"];
  if (folder === "analysis") return ["REPORT"];
  if (folder === "remote") return CLIENT_TYPES.filter(type => type !== "MARIYAMEETS" && type !== "SOCIAL");
  return isMariyaProject(root) ? ["MARIYAMEETS"] : CLIENT_TYPES.filter(type => type !== "MARIYAMEETS");
};
export const clientTypeLabel = (type: string, names?: Record<string, string>) =>
  names?.[type.toLowerCase()] ?? (type.toUpperCase() === "MARIYAMEETS" ? "MARIYA MEETS" : type);
export const isHuddleClientType = (type?: string | null) => type?.toUpperCase() === "HUDDLE";
