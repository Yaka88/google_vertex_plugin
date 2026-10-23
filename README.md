# GCP AI — Google Cloud credits and Vertex models (Magpie plugin)

- **Models**: the Vertex models Google lists for your project, newest first. Whether a particular one answers is something you find out with **Test models** on the one you picked.
- **Inference**: requests are signed with your local gcloud / ADC credentials and billed to your own project.
- **Credits** (optional): the quota panel can show the Google Cloud promotional credit balance and its expiry date.

You sign in once with your own Google account. No service accounts, no JSON keys, and no extra npm packages: the plugin drives the Chrome you already have.

## Requirements

- Google Chrome or Chromium. Linux, macOS and Windows are all supported; set `VERTEX_CHROME_PATH` if Chrome is somewhere unusual.
- Google Cloud CLI (`gcloud`), already working
- A Google Cloud project with Vertex AI enabled
- Reading credits needs permission to view the project's billing account (usually `billing.viewer`)

## Install and sign in

```bash
magpie plugin add @magpie-community/opencode-gcp-ai-auth
```

Then click sign in on the **GCP AI** row in the Providers page, or:

```bash
magpie plugin login gcp-ai
```

- **Every sign-in** opens exactly one Chrome window on a profile of the plugin's own. The first account goes straight to gcloud's consent page; a later one starts on Google's "add another account" page so you can pick the account, and continues to the consent page in the same window. Approve it there, and the plugin closes the window itself as soon as gcloud is done. You never close it. The window has no debugging connection of any kind, which is what makes Google accept the sign-in; a browser the plugin drives is turned away with "This browser or app may not be secure".
- **A sign-in counts only when its ADC is new.** The account is read from the ADC gcloud just wrote, and that account must not already be one this plugin or this machine has signed in with. Anything else is an overwrite: the plugin removes what it wrote, leaves your existing credentials untouched, and says that no account was added.
- **The project is chosen for you.** Once the ADC exists, the plugin asks Cloud Resource Manager for the account's projects and takes the first one with the Vertex AI API enabled. An account with no such project is not registered: the plugin removes the ADC this run wrote and tells you to create a project, enable the Vertex AI API in it, and sign in again. Set `GOOGLE_VERTEX_PROJECT` to use a different one.
- **Adding another account** is the same button again, with a different Google account in the window.
- Cookies stay in the Chrome profile (default `~/.config/gcp-auto-profile`) and are reused for credit reads, which do run in a browser the plugin drives — reading a page it is already signed in to is not something Google objects to.
- Authorization codes and tokens are handled by gcloud alone; the plugin never touches refresh tokens or client secrets.

## Credits

Google has no API for promotional credits, so the balance is read from the Cloud Console page. That means opening a browser — which the row does when it needs a balance, and only then. There is no switch to find or turn on.

The cache is what keeps a poll from costing a browser: a balance is reused for five minutes (`VERTEX_CREDITS_CACHE_TTL`) and a read that failed is remembered for twenty (`VERTEX_CREDITS_FAILURE_TTL`), so a project without `billing.viewer` is not asked again every few minutes for an answer that cannot change yet.

The accounts are read one after another in **one Chrome**: the first read opens the browser, each further account is another tab in it, and the browser closes once the reads stop (`VERTEX_CHROME_IDLE`, 30 s). Two accounts therefore cost one browser start, not two. Reads on the same profile take turns; different profiles do not wait for each other.

The lock that keeps two separate processes apart is a file under `~/.cache/magpie/gcp-ai`, so it holds even when magpie reads each account in its own process. A kept browser still holds that lock, so it steps aside as soon as another process wants the profile instead of making it wait.

Every read that names an account checks that Cloud Console really rendered that account, and refuses rather than report one account's balance on another's row.

## What it keeps where

- **Credentials**: never held by this plugin. gcloud writes ADC and prints access tokens on demand; the plugin only runs gcloud and reads its output.
- **ADC directories**: `~/.config/gcp-ai/adc-<account>`, one per Google account. The plugin never writes gcloud's default directory (`~/.config/gcloud`): that ADC is read by every other Google client on the machine. An ADC already there is used as it stands when it belongs to the account being signed in.
- **Chrome profile**: `~/.config/gcp-auto-profile`, with its cookies in the platform's own credential store.
- **Credits cache**: `~/.cache/magpie/gcp-ai`.

## FAQ

**No credits shown?** The Chrome sign-in has probably expired; sign in again and approve the consent page in the window that opens.

**"This browser or app may not be secure" during sign-in?** That window is not the plugin's doing: it means the sign-in was attempted in a browser the plugin drives, or in a window that was reopened by something else. Start the sign-in again from the row and use the window that opens; nothing in it is automated.

**"That account was already signed in"?** The sign-in is an addition, not a refresh. If the Google account approved in the window, or the ADC it produced, was already here, the plugin removes what this run wrote and keeps the existing row as it is.

**Changing project or region?** The project is the first one the account has with Vertex AI enabled; both can be set explicitly:

```bash
export GOOGLE_VERTEX_PROJECT=your-project-id
export GOOGLE_VERTEX_LOCATION=global
```

The model list is the one Google returns for the configured location, so a region-only model is not offered where it cannot be called.

**Wrong account on the consent page?** Google may preselect another account in Chrome. The plugin compares the account added in the window with the account the new ADC belongs to; on a mismatch it deletes exactly the one ADC file this run wrote, and nothing else. Sign in again and pick the right account on the consent page.

**Credits don't match the billing page?** Promotional credits belong to the billing account and can be shared across projects, and the Console itself has billing latency.

## Configuration

| Environment variable | Meaning / default |
| --- | --- |
| `GOOGLE_VERTEX_PROJECT` | Project ID; the first project with Vertex AI enabled by default |
| `GOOGLE_VERTEX_LOCATION` | Region, default `global` |
| `VERTEX_BILLING_ACCOUNT` | Billing account ID; looked up from the project by default |
| `VERTEX_CHROME_PROFILE` | Chrome profile directory, default `~/.config/gcp-auto-profile` |
| `VERTEX_CHROME_PATH` | Chrome / Chromium executable path |
| `VERTEX_CHROME_IDLE` | Seconds a browser kept between reads stays open with nothing to do, default `30`; `0` closes it right after each read |
| `VERTEX_CHROME_GAP` | Seconds to wait after a process closed its Chrome before the next process opens the same profile, default `0` |
| `VERTEX_GCLOUD_ACCOUNT` | Google account to use |
| `VERTEX_GCLOUD_AUTH_MODE` | `auto` (default), `adc` or `gcloud` |
| `VERTEX_CREDITS_CACHE_TTL` | Seconds a good balance is reused, default `300` |
| `VERTEX_CREDITS_FAILURE_TTL` | Seconds a failed read is reused, default `1200` |
| `CLOUDSDK_CONFIG` | gcloud config directory, default `~/.config/gcloud`; read when it holds ADC for the account |

## Privacy

The plugin only does this: asks Google for the model list with your credentials, sends inference requests to the Vertex endpoint, and — when the credit read is on — opens Cloud Console in a Chrome it started itself to read the credits page. No third-party server, no credential upload, no debugging port, and page cookies are never turned into tokens.
