import { clientTypeLabel } from "./clientTypes";
import "./ClientLabel.css";
/** Presentation only: the stored client token and its casing are never changed. */
export function parseClientLabel(raw:string) {
  const normalized = raw.trim().replace(/\s+/g, "_");
  const parts = normalized.split("_").filter(Boolean);
  const candidate = parts[parts.length - 1]?.toUpperCase();
  const type = parts.length > 1 && ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL"].includes(candidate) ? candidate : null;
  return {name:(type ? parts.slice(0, -1) : parts).join(" "), type, normalized};
}

export function ClientLabel({name,season}:{name:string;season?:string|null}) {
  const label = parseClientLabel(name);
  const seasonNumber = season?.match(/^SEASON\s+(\d+)$/i)?.[1];
  return <span className="pepper-client-label"><span className="pepper-client-label-name">{label.name}</span>{label.type && <span className={`client-tag ${label.type.toLowerCase()}`}>{clientTypeLabel(label.type)}</span>}{seasonNumber && <span className="client-tag season-tag" title={`Season ${seasonNumber}`} aria-label={`Season ${seasonNumber}`}>S{seasonNumber}</span>}</span>;
}
