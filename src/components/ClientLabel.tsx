import { clientTypeLabel } from "./clientTypes";
import "./ClientLabel.css";
/** Presentation only: the stored client token and its casing are never changed. */
export function parseClientLabel(raw:string) {
  const normalized = raw.trim().replace(/\s+/g, "_");
  const parts = normalized.split("_").filter(Boolean);
  const candidate = parts[parts.length - 1]?.toUpperCase();
  const type = parts.length > 1 && ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL", "REPORT"].includes(candidate) ? candidate : null;
  return {name:(type ? parts.slice(0, -1) : parts).join(" "), type, normalized};
}

export function ClientLabel({name,season,type,typeNames}:{name:string;season?:string|null;type?:string|null;typeNames?:Record<string,string>}) {
  const parsed = parseClientLabel(name);
  const label = {...parsed, type: type?.trim() || parsed.type};
  const seasonNumber = season?.match(/^SEASON\s+(\d+)$/i)?.[1];
  const displayName = label.type ? typeNames?.[label.type.toLowerCase()] ?? clientTypeLabel(label.type) : "";
  const normalized = name.trim().replace(/\s+/g, "_");
  const suffix = label.type ? `_${label.type.toUpperCase()}` : "";
  const visibleName = suffix && normalized.toUpperCase().endsWith(suffix)
    ? normalized.slice(0, -suffix.length).replace(/_/g, " ") : label.name;
  return <span className="pepper-client-label"><span className="pepper-client-label-name">{visibleName}</span>{label.type && <span className={`client-tag ${label.type.toLowerCase()}`}>{displayName}</span>}{seasonNumber && <span className="client-tag season-tag" title={`Season ${seasonNumber}`} aria-label={`Season ${seasonNumber}`}>S{seasonNumber}</span>}</span>;
}
