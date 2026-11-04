export const CLIENT_TYPES = ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number] | "CUSTOM";
export const isMariyaProject = (root: string) => root.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() === "8_mariya meets";
export const availableClientTypes = (root: string) => isMariyaProject(root)
  ? ["MARIYAMEETS"] as const
  : CLIENT_TYPES.filter(type => type !== "MARIYAMEETS");
export const clientTypeLabel = (type: string) => type === "MARIYAMEETS" ? "MARIYA MEETS" : type;
