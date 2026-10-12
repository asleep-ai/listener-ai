---
title: Privacy Policy
---

# Privacy Policy

_Last updated: 2026-10-12_

## 1. Who we are

Listener.AI is a desktop application provided by **Asleep, Inc.** ("Asleep", "we"), Republic of Korea.
Contact for privacy questions: **utils@asleep.ai**.

## 2. Scope

This policy explains what data Listener.AI handles, where it goes, and what choices you have. It applies to the Listener.AI desktop app and the companion `listener` CLI distributed under the same name.

## 3. Local-first by design

All audio recordings, transcripts, summaries, live notes, and metadata you create with Listener.AI are stored locally on your device, under the operating system's standard application-data directory.

We do not operate a server. We do not collect telemetry, usage analytics, crash reports, or any other data from your use of the app. There is no Asleep account to create. There is no Asleep-side log of what you record, transcribe, or sync.

## 4. Third-party services you connect

Listener.AI is "bring your own key" (BYOK): features that depend on third-party APIs require credentials you supply, and your data flows directly from your device to the third party. Asleep does not proxy, store, or observe these calls.

- **Google Gemini API** — transcription, summarization, agent chat. When you configure Listener.AI to use Gemini, the audio you transcribe and the prompts the app generates are sent to Google using your own Gemini API key. Your use of Gemini is governed by Google's privacy policy and your contract with Google.
- **OpenAI (Sign in with ChatGPT)** — summarization, transcript quality checks, report regeneration, agent chat. When you select **Continue with ChatGPT**, your browser signs you in to OpenAI (`auth.openai.com`); Listener.AI never sees your password. The app receives sign-in tokens, stores them locally (see §8), and sends the prompts it generates, which contain transcript text, to OpenAI's public API (`api.openai.com/v1`) on your ChatGPT plan. Audio is never sent through this sign-in. You can disconnect in Settings, which also asks OpenAI to revoke the sign-in, or remove Listener.AI from your ChatGPT settings.
- **OpenAI API (API key)** — recording transcription and live captions. When you choose OpenAI as the transcription or live provider, the audio is sent to OpenAI's API using your own OpenAI API key and is billed to your OpenAI API account, separately from any ChatGPT plan. Your use of OpenAI is governed by OpenAI's privacy policy and terms.
- **Google Drive sync (optional)** — when you enable Drive sync, Listener.AI signs you in to Google using the **`https://www.googleapis.com/auth/drive.file`** scope. This scope restricts the app to files it creates in your Drive; Listener.AI cannot see your other files, folders, or content. The app uploads each meeting's transcript, summary, and source audio file to a "Listener.AI" folder in your own Google Drive. On other devices signed into the same Google account, the app downloads transcripts and summaries automatically but leaves audio cloud-only (you decide when, or whether, to download a recording). Deleting a meeting in Listener.AI moves the corresponding Drive folder to Drive's trash (the standard ~30-day recovery window applies). When two devices edit the same meeting between syncs, the older version is preserved as a local backup rather than silently overwritten.
- **Notion (optional)** — when you configure a Notion integration token and database ID, transcripts you choose to upload are written to your own Notion database using your own credentials. Your use is governed by Notion's privacy policy.

You control whether to connect each service. You can disconnect at any time in the app's Settings, revoke OAuth at the third party's account-security page, and delete data on the third party's side directly.

## 5. International data transfers

The third-party services above may process your data in countries outside your country of residence (for example, in the United States for Google, OpenAI, and Notion). Asleep is not a party to that transfer; it is governed by your relationship with the service provider, including any standard contractual clauses they offer.

## 6. Retention

We do not retain any of your data, because we do not collect any. Local data persists on your device until you delete it (per-meeting in the app, or by removing the application-data directory). Cloud copies persist according to the third party's retention rules and your own deletion actions.

## 7. Your rights

Because Asleep holds no personal data about you, there is no Asleep-side data set you need to request access to, correct, or erase. To remove your data, you act on the device or the third-party service that holds it:

- **Local data:** delete a meeting from the app's recordings list, empty the application-data directory, or uninstall the app.
- **Google Drive copies:** open Drive trash to permanently remove synced files; the standard ~30-day retention then applies.
- **OAuth access:** revoke the "Listener.AI" entry at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). Future sync attempts will fail until you re-authorize.
- **ChatGPT sign-in:** sign out in Listener.AI's Settings (or run `listener chatgpt logout`), which revokes the sign-in with OpenAI and deletes the local tokens. You can also remove Listener.AI from your ChatGPT settings; the app then stops working on your plan until you sign in again.
- **Other third parties:** delete the relevant Notion pages or OpenAI/Gemini API keys directly with those providers.

If you are in the EU/EEA, UK, or Switzerland, you have rights under the GDPR (or equivalent), including access, rectification, erasure, restriction, portability, objection, and the right to lodge a complaint with a supervisory authority. For requests regarding data held by the third parties listed in §4, contact them directly. For Listener.AI itself, our answer to any access or deletion request is the same as above: we hold nothing to disclose, correct, or delete.

If you are a California resident: we **do not sell or share** your personal information, and we do not process information that would qualify you for additional CCPA/CPRA rights (we collect none).

## 8. Security

The app stores local files with restrictive permissions where the operating system supports it (mode `0600` for OAuth refresh tokens, API keys, and sync state on macOS and Linux). ChatGPT sign-in tokens are kept in their own files, separate from the settings file, and are never shown in the app's interface or sent to any party other than OpenAI. Once data is transmitted to a third-party service, security is governed by that provider.

## 9. Children

Listener.AI is not directed at children under 13 (or under 16 where that is the local minimum age for online consent). We do not knowingly process data from such children. If you believe a child has used the app under your account, deleting the local data and revoking OAuth removes Asleep from the picture; the third-party providers' own policies govern any data they may hold.

## 10. Changes to this policy

We may update this policy when the app's data flows change. Material changes will be reflected in the "Last updated" date at the top of this page; significant changes will also be noted in the release notes for the version that ships them. Continuing to use the app after a change indicates acceptance.

## 11. Contact

Email: **utils@asleep.ai**
Mailing address: Asleep, Inc., Seoul, Republic of Korea.
