use keyring::Entry;
use lettre::{
    message::{header::ContentType, Mailbox},
    transport::smtp::authentication::Credentials,
    Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "Pepper.Gmail";
const SMTP_HOST: &str = "smtp.gmail.com";

#[derive(Serialize, Deserialize, Clone)]
pub struct StudioMailRecipient {
    id: String,
    name: String,
    email: String,
}

fn default_recipients() -> Vec<StudioMailRecipient> {
    vec![
        StudioMailRecipient { id: "mariya".into(), name: "Mariya".into(), email: "mariya@playerspublishing.com".into() },
        StudioMailRecipient { id: "tim".into(), name: "Tim".into(), email: "tim.poole@globalgaminginsider.com".into() },
        StudioMailRecipient { id: "will".into(), name: "Will".into(), email: "will.underwood@globalgaminginsider.com".into() },
    ]
}

fn sort_recipients(recipients: &mut [StudioMailRecipient]) {
    recipients.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.email.to_lowercase().cmp(&b.email.to_lowercase())));
}

fn recipients_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map(|path| path.join("studio-mail-recipients.json"))
        .map_err(|e| format!("Unable to locate Pepper settings folder: {e}"))
}

fn load_recipients(app: &AppHandle) -> Result<Vec<StudioMailRecipient>, String> {
    let path = recipients_path(app)?;
    if !path.exists() { return Ok(default_recipients()); }
    let bytes = fs::read(&path).map_err(|e| format!("Unable to read saved email contacts: {e}"))?;
    let mut recipients: Vec<StudioMailRecipient> = serde_json::from_slice(&bytes).map_err(|e| format!("Saved email contacts are invalid: {e}"))?;
    let replace_callum = recipients.iter().any(|recipient| recipient.email.eq_ignore_ascii_case("callum.flett@globalgaminginsider.com"));
    let mariya_already_exists = recipients.iter().any(|recipient| recipient.email.eq_ignore_ascii_case("mariya@playerspublishing.com"));
    let mut migrated = false;
    if replace_callum && mariya_already_exists {
        recipients.retain(|recipient| !recipient.email.eq_ignore_ascii_case("callum.flett@globalgaminginsider.com"));
        migrated = true;
    }
    for recipient in &mut recipients {
        if recipient.email.eq_ignore_ascii_case("callum.flett@globalgaminginsider.com") {
            recipient.id = "mariya".into();
            recipient.name = "Mariya".into();
            recipient.email = "mariya@playerspublishing.com".into();
            migrated = true;
        }
    }
    sort_recipients(&mut recipients);
    if migrated {
        let bytes = serde_json::to_vec_pretty(&recipients).map_err(|e| e.to_string())?;
        fs::write(path, bytes).map_err(|e| format!("Unable to update saved email contacts: {e}"))?;
    }
    Ok(recipients)
}

#[tauri::command]
pub fn studio_mail_recipients(app: AppHandle) -> Result<Vec<StudioMailRecipient>, String> {
    load_recipients(&app)
}

#[tauri::command]
pub fn studio_mail_save_recipients(app: AppHandle, recipients: Vec<StudioMailRecipient>) -> Result<Vec<StudioMailRecipient>, String> {
    if recipients.len() > 100 { return Err("You can save up to 100 email contacts.".into()); }
    let mut ids = HashSet::new();
    let mut emails = HashSet::new();
    let mut normalized = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        let id = recipient.id.trim().to_string();
        let name = recipient.name.trim().to_string();
        let email = recipient.email.trim().to_string();
        if id.is_empty() || name.is_empty() || name.chars().count() > 100 {
            return Err("Each contact needs a name of 1 to 100 characters.".into());
        }
        let _: Address = email.parse().map_err(|_| format!("Enter a valid email address for {name}."))?;
        if !ids.insert(id.clone()) { return Err("Each saved contact needs a unique ID.".into()); }
        if !emails.insert(email.to_ascii_lowercase()) { return Err(format!("{email} is listed more than once.")); }
        normalized.push(StudioMailRecipient { id, name, email });
    }
    sort_recipients(&mut normalized);
    let path = recipients_path(&app)?;
    let parent = path.parent().ok_or("Unable to locate Pepper settings folder.")?;
    fs::create_dir_all(parent).map_err(|e| format!("Unable to create Pepper settings folder: {e}"))?;
    let bytes = serde_json::to_vec_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| format!("Unable to save email contacts: {e}"))?;
    Ok(normalized)
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("OS credential store unavailable: {e}"))
}

fn read(key: &str) -> Option<String> {
    entry(key).ok()?.get_password().ok()
}

fn delete_legacy_credentials() {
    for (service, key) in [
        ("Pepper.WorkMail", "sender"),
        ("Pepper.WorkMail", "password"),
        ("Pepper.Fastmail", "sender"),
        ("Pepper.Fastmail", "password"),
    ] {
        if let Ok(entry) = Entry::new(service, key) {
            let _ = entry.delete_credential();
        }
    }
}

#[derive(Serialize)]
pub struct MailSettingsStatus {
    configured: bool,
    sender: Option<String>,
}

#[tauri::command]
pub fn studio_mail_status() -> MailSettingsStatus {
    let sender = read("sender");
    MailSettingsStatus {
        configured: sender.is_some() && read("password").is_some(),
        sender,
    }
}

#[tauri::command]
pub fn studio_mail_save_credentials(sender: String, password: String) -> Result<(), String> {
    let sender = sender.trim();
    if !sender.contains('@') || sender.chars().any(char::is_whitespace) {
        return Err("Enter a valid full email address.".into());
    }
    if password.is_empty() {
        return Err("Enter the Google app password.".into());
    }
    entry("sender")?.set_password(sender).map_err(|e| format!("Unable to save email address: {e}"))?;
    entry("password")?.set_password(&password).map_err(|e| format!("Unable to save email password securely: {e}"))?;
    delete_legacy_credentials();
    Ok(())
}

#[tauri::command]
pub async fn studio_mail_send_link(app: AppHandle, session_title: String, session_url: String, recipient_email: String) -> Result<(), String> {
    if !session_url.starts_with("https://") {
        return Err("This session does not have a valid HTTPS link.".into());
    }
    let recipients = load_recipients(&app)?;
    let recipient_email = recipient_email.trim();
    let recipient_address: Address = recipient_email.parse()
        .map_err(|_| "Enter a valid full email address.".to_string())?;
    let saved_recipient = recipients.iter().find(|recipient| recipient.email.eq_ignore_ascii_case(recipient_email));
    let sender = read("sender").ok_or_else(|| "Set up Gmail in Settings > Integrations first.".to_string())?;
    let password = read("password").ok_or_else(|| "Set up Gmail in Settings > Integrations first.".to_string())?;
    let from: Mailbox = sender.parse().map_err(|e| format!("Invalid sender address: {e}"))?;
    let to = Mailbox::new(None, recipient_address);
    let subject = format!("Restream Studio link: {}", session_title.trim());
    let greeting = saved_recipient.map(|recipient| format!("Hi {},", recipient.name)).unwrap_or_else(|| "Hi,".to_string());
    let body = format!("{greeting}\n\nHere is the Restream Studio link for {}:\n{}\n", session_title.trim(), session_url);
    let message = Message::builder().from(from).to(to).subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body).map_err(|e| format!("Unable to prepare email: {e}"))?;
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay(SMTP_HOST)
        .map_err(|e| format!("Unable to configure Gmail SMTP: {e}"))?
        .port(465)
        .credentials(Credentials::new(sender, password))
        .build();
    mailer.send(message).await.map_err(|e| format!("Gmail could not send the message: {e}"))?;
    Ok(())
}
