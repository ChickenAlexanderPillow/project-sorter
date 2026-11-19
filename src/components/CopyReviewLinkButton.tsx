import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./CopyReviewLinkButton.css";

export function CopyReviewLinkButton({ url, version, label = `V${version} review link`, onCopy }: {
  url: string;
  version: number;
  label?: string;
  onCopy: (url: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestId = useRef(0);

  useEffect(() => {
    setCopied(false);
    setPending(false);
    return () => {
      requestId.current += 1;
      clearTimeout(timer.current);
    };
  }, [url]);

  const copy = async () => {
    const request = ++requestId.current;
    clearTimeout(timer.current);
    setPending(true);
    try {
      const success = await onCopy(url);
      if (request !== requestId.current) return;
      if (!success) {
        setCopied(false);
        return;
      }
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1000);
    } finally {
      if (request === requestId.current) setPending(false);
    }
  };

  return <button
    type="button"
    className={`frameio-icon-button copy review-copy-button${copied ? " copied" : ""}`}
    title={copied ? "Copied" : `Copy ${label}`}
    aria-label={copied ? `${label} copied` : `Copy ${label}`}
    disabled={pending}
    onClick={() => void copy()}
  >
    <span className="copy-feedback-icon copy-feedback-copy" aria-hidden="true"><Copy size={14} /></span>
    <span className="copy-feedback-icon copy-feedback-check" aria-hidden="true"><Check size={15} /></span>
  </button>;
}
