# GCP AI — Google Cloud credits and Vertex models (Magpie plugin)

- **Models**: the Vertex chat models your project can call, newest first.
- **Inference**: requests are signed with your local gcloud / ADC credentials and billed to your own project.
- **Credits**: the quota panel can show your Google Cloud promotional credit balance and its expiry date.

You sign in once with your own Google account. No service accounts, no JSON keys, no extra packages: the plugin uses the Chrome you already have.

## Requirements

- Google Chrome or Chromium (set `VERTEX_CHROME_PATH` if it is somewhere unusual)
- Google Cloud CLI (`gcloud`), already working
- A Google Cloud project with Vertex AI enabled
- To read credits: permission to view the project's billing account (usually `billing.viewer`)

## Install and sign in

```bash
magpie plugin add @magpie-community/gcp-ai
```

Then click sign in on the **GCP AI** row, or run:

```bash
magpie plugin login gcp-ai
```

One Chrome window opens. Approve the consent page there and the plugin closes the window itself — never close it yourself.

- The first account goes straight to Google's consent page. Adding a second one starts on Google's account picker instead, in the same window.
- Add another account by clicking sign in again with a different Google account.
- The project is picked for you: the first of the account's projects with the Vertex AI API enabled.
- If the account already has an ADC here, nothing is added and your existing sign-in is left alone.

## Credits

Google has no API for promotional credits, so the balance is read from the Cloud Console page. The row opens a browser when it needs a balance, and only then. Balances are cached for five minutes.

## What it keeps where

- **Credentials**: never held by the plugin. gcloud writes them and prints tokens on demand.
- **ADC directories**: `~/.config/gcp-ai/adc-<account>`, one per Google account. The plugin never writes `~/.config/gcloud`.
- **Chrome profile**: `~/.config/gcp-auto-profile`.
- **Cache**: `~/.cache/magpie/gcp-ai`.

## FAQ

**No credits shown?** The Chrome sign-in has probably expired. Sign in again.

**"This browser or app may not be secure"?** Start the sign-in again from the row and use the window that opens. Nothing in it is automated.

**"That account was already signed in"?** Signing in adds an account; it does not refresh one. Use a different Google account.

**Wrong account on the consent page?** Sign in again and pick the right one. Nothing that was already here is removed.

**Credits don't match the billing page?** Promotional credits belong to the billing account and can be shared across projects, and the Console has billing latency.

## Configuration

| Environment variable | Default |
| --- | --- |
| `GOOGLE_VERTEX_LOCATION` | `global` |
| `VERTEX_BILLING_ACCOUNT` | Looked up from the project |
| `VERTEX_CHROME_PROFILE` | `~/.config/gcp-auto-profile` |
| `VERTEX_CHROME_PATH` | Detected |
| `VERTEX_GCLOUD_ACCOUNT` | The signed-in account |
| `VERTEX_GCLOUD_AUTH_MODE` | `auto`; also `adc` or `gcloud` |
| `VERTEX_CHROME_IDLE` | `30` seconds a kept browser waits before closing; `0` closes it right away |
| `VERTEX_CHROME_GAP` | `0` seconds between one process closing Chrome and the next opening the profile |
| `VERTEX_CREDITS_CACHE_TTL` | `300` seconds |
| `VERTEX_CREDITS_FAILURE_TTL` | `1200` seconds |
| `VERTEX_CREDITS_TRANSIENT_TTL` | `60` seconds, for network failures |
| `VERTEX_MODELS_CACHE_TTL` | `21600` seconds (6 hours) |
| `CLOUDSDK_CONFIG` | `~/.config/gcloud` |

## Privacy

The plugin asks Google for your model list with your credentials, sends inference requests to the Vertex endpoint, and opens Cloud Console in a Chrome it started to read your credits. No third-party server, no credential upload, no debugging port.
