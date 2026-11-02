import "./ClientLabel.css";
/** Presentation only: the stored client token and its casing are never changed. */
export function parseClientLabel(raw:string) {
  const normalized = raw.trim().replace(/\s+/g, "_");
  const parts = normalized.split("_").filter(Boolean);
  const candidate = parts[parts.length - 1]?.toUpperCase();
  const type = parts.length > 1 && ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL"].includes(candidate) ? candidate : null;
  return {name:(type ? parts.slice(0, -1) : parts).join(" "), type, normalized};
}

export function ClientLabel({name}:{name:string}) {
  const label = parseClientLabel(name);
  return <span className="pepper-client-label"><span className="pepper-client-label-name">{label.name}</span>{label.type && <span className={`client-tag ${label.type.toLowerCase()}`}>{label.type}</span>}</span>;
}
