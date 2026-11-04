import { useId } from "react";
import { MapPin, Video } from "lucide-react";

export type HuddleTemplate = "VIDEO_CALL" | "PHYSICAL";

export function InterviewTypeSelect({ value, onChange, disabled = false }: {
  value: HuddleTemplate;
  disabled?: boolean;
  onChange: (value: HuddleTemplate) => void;
}) {
  const name = useId();
  return (
    <fieldset className="interview-select" disabled={disabled}>
      <legend>Interview type</legend>
      <div className="interview-select-options">
        {([
          { value: "VIDEO_CALL", title: "Video call", description: "Remote · scene switching", Icon: Video },
          { value: "PHYSICAL", title: "In person", description: "On-site interview", Icon: MapPin },
        ] as const).map(({ value: option, title, description, Icon }) => (
          <label className="interview-select-choice" key={option}>
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
            <Icon size={17} aria-hidden="true" />
            <span><strong>{title}</strong><small>{description}</small></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
