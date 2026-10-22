# GCP AI — Google Cloud credits and Vertex models (Magpie plugin)

- **Models**: only the Vertex models your project can actually call, newest first.
- **Inference**: requests are signed with your local gcloud / ADC credentials and billed to your own project.
- **Credits**: the quota panel shows the Google Cloud promotional credit balance and its expiry date.

You sign in once with your own Google account. No service accounts, no JSON keys.

## Requirements

- Google Chrome or Chromium
- Google Cloud CLI (`gcloud`), already working
- A Google Cloud project with Vertex AI enabled
- Reading credits needs permission to view the project's billing account (usually `billing.viewer`)

## Install and sign in

Run this inside the plugin directory

```bash
magpie plugin add .
```

Then click sign in on the **GCP AI** row in the Providers page, or:

```bash
magpie plugin login gcp-ai
```

- **First sign-in** opens a Chrome window and uses the Google account Chrome is already signed in to. If the machine has no ADC yet, the plugin also has gcloud write it from this window, so you never sign in twice.
- **Adding another account** is the same button again: the plugin opens Google's "add another account" page. An account that differs from the ones already here is added; the same account again adds nothing and says so.
- Each account keeps its own ADC directory (`~/.config/gcp-adc-<account>`), so two credentials coexist. The first account keeps using gcloud's default directory (`~/.config/gcloud`) if it is already there.
- The window closes by itself when the sign-in is done. Cookies stay in the Chrome profile (default `~/.config/gcp-auto-profile`) and are reused for credit reads.
- Authorization codes and tokens are handled by gcloud alone; the plugin never touches refresh tokens or client secrets.

## FAQ

**No credits shown?** The Chrome sign-in has usually expired; sign in again.

**Changing project or region?** The project is read from the Console by default; both can be set explicitly:

```bash
export GOOGLE_VERTEX_PROJECT=your-project-id
export GOOGLE_VERTEX_LOCATION=global
```

**Wrong account on the consent page?** Google may preselect another account in Chrome. The plugin checks the account the credentials actually belong to; on a mismatch it saves nothing and removes the ADC directory this run created. Sign in again and pick the right account on the consent page.

**Credits don't match the billing page?** Promotional credits belong to the billing account and can be shared across projects, and the Console itself has billing latency.

## Configuration

| Environment variable | Meaning / default |
| --- | --- |
| `GOOGLE_VERTEX_PROJECT` | Project ID; read from the Console by default |
| `GOOGLE_VERTEX_LOCATION` | Region, default `global` |
| `VERTEX_BILLING_ACCOUNT` | Billing account ID; looked up from the project by default |
| `VERTEX_CHROME_PROFILE` | Chrome profile directory, default `~/.config/gcp-auto-profile` |
| `VERTEX_CHROME_PATH` | Chrome / Chromium executable path |
| `VERTEX_GCLOUD_ACCOUNT` | Google account to use |
| `VERTEX_GCLOUD_AUTH_MODE` | `auto` (default), `adc` or `gcloud` |
| `CLOUDSDK_CONFIG` | gcloud config directory, default `~/.config/gcloud`; assigned per account when several exist |

## Privacy

The plugin only does this: asks Google for the model list and a free token count with your credentials, sends inference requests to the Vertex endpoint, and opens Cloud Console in your local Chrome to read the credits page. No third-party server, no credential upload, and page cookies are never turned into tokens.
