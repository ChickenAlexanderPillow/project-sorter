import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { GmailBrand } from "./IntegrationBrand";

type MailStatus = { configured: boolean; sender?: string | null };
type MailRecipient = { id: string; name: string; email: string };
const sortPeople = (people: MailRecipient[]) => [...people].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.email.localeCompare(b.email, undefined, { sensitivity: "base" }));

export function StudioMailSettings() {
  const [status, setStatus] = useState<MailStatus>({ configured: false });
  const [sender, setSender] = useState("");
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const refresh = () => invoke<MailStatus>("studio_mail_status").then(value => {
    setStatus(value);
    setEditing(!value.configured);
    if (value.sender) setSender(value.sender);
  }).catch(error => setFeedback(String(error)));

  useEffect(() => {
    void refresh();
  }, []);

  const saveCredentials = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback("");
    try {
      await invoke("studio_mail_save_credentials", { sender, password });
      await refresh();
      setPassword("");
      setFeedback("Gmail is ready to send session links.");
    } catch (error) { setFeedback(String(error)); }
    finally { setBusy(false); }
  };

  return <section className="integration-provider" aria-labelledby="integration-gmail-title">
    <header className="integration-heading">
      <GmailBrand />
      {!status.configured && <span className="integration-status integration-issues" role="status"><TriangleAlert size={12} aria-hidden="true" />1 Issue</span>}
    </header>
    <details className="integration-options">
      <summary aria-label="Gmail connection options">Connection options</summary>
      <form className="studio-mail-settings" onSubmit={event => void saveCredentials(event)}>
      <label>Gmail address<input type="email" autoComplete="username" required={editing} disabled={!editing || busy} value={sender} onChange={event => setSender(event.target.value)} placeholder="studio.links@gmail.com" /></label>
      <label>Google app password<input type="password" autoComplete="new-password" required={editing} disabled={!editing || busy} value={editing ? password : "saved-app-password"} onChange={event => setPassword(event.target.value)} /></label>
      {!editing && <button type="button" className="ghost" disabled={busy} onClick={() => { setEditing(true); setPassword(""); setFeedback(""); }}>Edit credentials</button>}
      {editing && <div className="studio-mail-actions">
        <button type="submit" className="ghost" disabled={busy || !sender.trim() || !password}>{busy ? "Saving…" : status.configured ? "Save changes" : "Save credentials"}</button>
        {status.configured && <button type="button" className="ghost" disabled={busy} onClick={() => { setPassword(""); setSender(status.sender || ""); setEditing(false); setFeedback(""); }}>Cancel</button>}
      </div>}
      {feedback && <p className="settings-feedback" role="status">{feedback}</p>}
      </form>
      <small className="studio-mail-recipient">Use a separate Gmail account with 2-Step Verification and an app password.</small>
    </details>

  </section>;
}

export function StudioMailPeopleSettings() {
  const [recipients, setRecipients] = useState<MailRecipient[]>([]);
  const [savedRecipients, setSavedRecipients] = useState<MailRecipient[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [peopleFeedback, setPeopleFeedback] = useState("");
  const lastAttemptedSave = useRef("");
  const saveInProgress = useRef(false);
  const pendingPeopleSave = useRef<MailRecipient[] | null>(null);

  useEffect(() => {
    void invoke<MailRecipient[]>("studio_mail_recipients").then(value => {
      setRecipients(sortPeople(value));
      setSavedRecipients(sortPeople(value));
    }).catch(error => setPeopleFeedback(String(error))).finally(() => setPeopleLoading(false));
  }, []);

  const saveRecipients = async (snapshot = recipients) => {
    if (saveInProgress.current) { pendingPeopleSave.current = snapshot; return; }
    saveInProgress.current = true;
    const signature = JSON.stringify(snapshot);
    lastAttemptedSave.current = signature;
    setPeopleBusy(true);
    setPeopleFeedback("");
    try {
      const saved = await invoke<MailRecipient[]>("studio_mail_save_recipients", { recipients: snapshot });
      setSavedRecipients(sortPeople(saved));
      setRecipients(current => JSON.stringify(current) === signature ? sortPeople(saved) : current);
      window.dispatchEvent(new CustomEvent("pepper-mail-recipients-updated", { detail: saved }));
    } catch (error) { setPeopleFeedback(String(error)); }
    finally {
      setPeopleBusy(false);
      saveInProgress.current = false;
      const pending = pendingPeopleSave.current;
      pendingPeopleSave.current = null;
      if (pending && JSON.stringify(pending) !== signature) void saveRecipients(pending);
    }
  };

  const saveOnBlur = (snapshot: MailRecipient[]) => {
    const signature = JSON.stringify(snapshot);
    const emails = snapshot.map(person => person.email.trim().toLowerCase());
    const ready = snapshot.every(person => person.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email.trim()))
      && new Set(emails).size === emails.length;
    if (!peopleLoading && ready && signature !== JSON.stringify(savedRecipients) && signature !== lastAttemptedSave.current) void saveRecipients(snapshot);
  };

  const addRecipient = () => {
    setRecipients(current => sortPeople([...current, { id: crypto.randomUUID(), name: "", email: "" }]));
    setPeopleFeedback("");
  };

  return <section className="studio-mail-people" aria-labelledby="studio-mail-people-title">
      <header className="studio-mail-people-heading">
        <h5 id="studio-mail-people-title">People</h5>
        <button type="button" className="ghost" onClick={addRecipient} disabled={peopleLoading || peopleBusy}><Plus size={13} />Add person</button>
      </header>
      <div className="studio-mail-contact-list" aria-busy={peopleLoading || peopleBusy}>
        {peopleLoading ? <p className="settings-feedback">Loading saved people…</p> : recipients.map((person, index) => <div className="studio-mail-contact" key={person.id}>
          <label>Name<input value={person.name} maxLength={100} onChange={event => setRecipients(current => sortPeople(current.map(item => item.id === person.id ? { ...item, name: event.target.value } : item)))} onBlur={event => { const next = sortPeople(recipients.map(item => item.id === person.id ? { ...item, name: event.currentTarget.value } : item)); saveOnBlur(next); }} placeholder="Name" /></label>
          <label>Email address<input type="email" value={person.email} onChange={event => setRecipients(current => sortPeople(current.map(item => item.id === person.id ? { ...item, email: event.target.value } : item)))} onBlur={event => { const next = sortPeople(recipients.map(item => item.id === person.id ? { ...item, email: event.currentTarget.value } : item)); saveOnBlur(next); }} placeholder="name@example.com" /></label>
          <button type="button" className="frameio-icon-button studio-mail-contact-remove" aria-label={`Remove ${person.name || `person ${index + 1}`}`} title="Remove person" onClick={() => { const next = sortPeople(recipients.filter(item => item.id !== person.id)); setRecipients(next); saveOnBlur(next); }}><Trash2 size={14} /></button>
        </div>)}
        {!peopleLoading && !recipients.length && <p className="settings-feedback">No saved people.</p>}
      </div>
      {peopleFeedback && <p className="settings-feedback" role="alert">{peopleFeedback}</p>}
    </section>;
}
