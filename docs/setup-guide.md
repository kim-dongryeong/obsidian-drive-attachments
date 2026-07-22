# Illustrated Setup Guide

A screenshot walkthrough of the one-time Google Cloud setup for Drive Attachments.

## 1. Create a Google Cloud project

![New Project screen — name the project and click Create](media/setup/01-create-project.png)

## 2. Enable the Google Drive API

![Project dashboard — your new project is active; open the API Library next](media/setup/02-project-dashboard.png)
![Search the API Library for "Google Drive API"](media/setup/03-search-drive-api.png)
![Google Drive API page — click Enable](media/setup/04-enable-drive-api.png)

## 3. Configure the OAuth consent screen

![Google Drive API enabled — now open the OAuth consent screen](media/setup/05-drive-api-enabled.png)
![Google Auth Platform not configured yet — click Get started](media/setup/06-auth-platform-get-started.png)
![App information — app name and support email](media/setup/07-consent-app-info.png)
![Audience — choose Internal or External user type](media/setup/08-consent-audience-type.png)
![Contact information — your email address](media/setup/09-consent-contact-info.png)
![Finish — agree to the API Services User Data Policy](media/setup/10-consent-finish.png)

## 4. Publish the app (External user type only)

![Audience page — click Publish app](media/setup/12-publish-app-external.png)
![Confirm pushing the app to production](media/setup/13-publish-app-confirm.png)

## 5. Create an OAuth client and download the JSON

![OAuth configuration created — now create an OAuth client](media/setup/11-oauth-configured.png)
![Create OAuth client ID — select Desktop app](media/setup/14-create-oauth-client-desktop.png)
![OAuth client created — click Download JSON](media/setup/15-oauth-client-created-json.png)

## 6. Import the JSON in the plugin

![Drive Attachments settings — select the downloaded JSON file](media/setup/17-plugin-select-json.png)
![Google sign-in — choose your account](media/setup/18-choose-google-account.png)
![Unverified app warning — click Advanced](media/setup/19-unverified-app-warning.png)
![Advanced expanded — click "Go to Drive Attachments (unsafe)"](media/setup/20-unverified-app-advanced.png)
![Consent screen — review and allow the requested Drive scopes](media/setup/21-consent-scopes.png)

## Optional: Picker API key

Only needed if you want Google's own file-picker popup; everything else works without it.

![Clients/Credentials list — go to Create credentials → API key](media/setup/16-clients-list.png)
![Credentials page — Create credentials → API key](media/setup/22-create-credentials-api-key.png)
![Create API key — restrict it to the Google Picker API](media/setup/23-create-picker-api-key.png)
![API key created — paste it into Drive Attachments' settings](media/setup/24-picker-api-key-created.png)
