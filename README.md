# pi-kiro-connect

[![CI](https://github.com/vnlebaoduy/pi-kiro-connect/actions/workflows/ci.yml/badge.svg)](https://github.com/vnlebaoduy/pi-kiro-connect/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/vnlebaoduy/pi-kiro-connect)](https://github.com/vnlebaoduy/pi-kiro-connect/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Kiro (AWS CodeWhisperer / Amazon Q) provider for [pi](https://github.com/badlogic/pi-mono) and [Oh My Pi](https://github.com/can1357/oh-my-pi). It signs in the way `kiro-cli` does, lists the models your Kiro account can actually use, and streams them into either host.

> Forked from [mikeyobrien/pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro) (MIT). See [NOTICE](NOTICE) for attribution. This is an unofficial project, not affiliated with Amazon or Kiro.

## Install

### One command (pi, omp, or both)

```bash
curl -fsSL https://raw.githubusercontent.com/vnlebaoduy/pi-kiro-connect/main/scripts/install.sh | bash
```

The installer installs the latest release into every host it finds on `PATH` and removes `pi-provider-kiro` if it is installed, because both register the same `kiro` provider. Options:

| Flag | Effect |
|---|---|
| `--version v0.13.0` | Install a specific release |
| `--pi` / `--omp` | Install into one host only |
| `--uninstall` | Remove pi-kiro-connect |

To read the script before running it, download it first:

```bash
curl -fsSLO https://raw.githubusercontent.com/vnlebaoduy/pi-kiro-connect/main/scripts/install.sh
less install.sh && bash install.sh
```

### Oh My Pi

```bash
omp plugin install github:vnlebaoduy/pi-kiro-connect#v0.13.0
```

omp installs with Bun and loads `src/index.ts` directly, so it needs no build step. To update, run the same command with a newer tag.

### pi

```bash
pi install git:github.com/vnlebaoduy/pi-kiro-connect@release/v0.13.0
```

A git install in pi only runs `npm install` and never the build, while pi loads `dist/index.js`. For that reason every release publishes a `release/vX.Y.Z` branch that is the tag plus the prebuilt `dist/`. Always pin pi to one of those branches, not to the plain tag or to `main`.

### From source

```bash
git clone https://github.com/vnlebaoduy/pi-kiro-connect.git
cd pi-kiro-connect && npm ci && npm run build
pi install ./            # pi
omp plugin link ./       # Oh My Pi
```

## Sign in

Start pi or omp, run `/login`, choose **Kiro**, then pick a method:

| Method | How it works |
|---|---|
| AWS Builder ID | Device-code flow in the browser. Works over SSH. |
| Your organization | IAM Identity Center start URL. The SSO region is detected automatically. |
| Google / GitHub | Hands the sign-in to `kiro-cli login`, so `kiro-cli` must be installed |
| API key | A `ksk_…` key, or set it in `KIRO_API_KEY` |

### Compatibility with kiro-cli

Identity Center and Builder ID sign-in follow `kiro-cli` exactly:

- **One OIDC client.** pi/omp reuses the `Kiro CLI` client that `kiro-cli` already registered for your region, with the same three scopes, instead of registering another one. AWS therefore sees a single client per user.
- **One session.** After you sign in from pi/omp, `kiro-cli` is signed in too, and the reverse also holds: an existing `kiro-cli` session is picked up without a second login. Both tools refresh the same token family, so neither one invalidates the other.
- **Known region first.** If `kiro-cli` has already signed in to your start URL, its region is tried before any others.

Signing in from pi/omp replaces the `kiro-cli` Identity Center session, as running `kiro-cli login` again would.

Credentials are looked up in this order: `KIRO_API_KEY` (or `OMP_KIRO_PROVIDER_KEY` on omp), then the host's own saved login, then `kiro-cli` (social, IdC, external IdP), then the Kiro IDE (`~/.aws/sso/cache/kiro-auth-token.json`).

If your organization signs in through an external OIDC provider such as Okta, run `kiro-cli login` once and the provider reuses that session.

## Models

The model list is **fetched live** from Kiro's management API for your account's region and profile. It is cached in `~/.pi/agent/kiro-management-models-cache.json` and refreshed hourly, so new Kiro models appear without a new release. A built-in list is only shown before your first successful sign-in.

```text
/model auto              # let Kiro choose
/model claude-sonnet-4-6
```

Reasoning is turned on automatically for models that support it. Use `/reasoning` (pi) or the thinking level (omp) to adjust it.

## Usage and credits

- **omp:** `omp usage` and `/usage` show monthly Kiro credits (used, limit, reset date), plus any free-trial bonus credits.
- **pi:** an optional footer badge (for example `◆ Kiro 12%`) shows how much of the allowance is used. Turn it on in `~/.pi/agent/settings.json`:

```json
{
  "pi-kiro-connect": {
    "showUsageInFooter": true,
    "usageTracking": {
      "estimateDollarValue": true,
      "estimateCacheUsage": true
    }
  }
}
```

`estimateDollarValue` converts credits to USD at `$0.04` per credit by default (override it with `usdPerCredit`). `estimateCacheUsage` marks prompt tokens repeated from the previous turn as cache reads. Both are estimates, not billing data.

> Migrating from `pi-provider-kiro`: rename the `"pi-provider-kiro"` key in `settings.json` to `"pi-kiro-connect"`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No API key found for kiro` | Run `/login` again. If it keeps returning, check `kiro-cli whoami`; a stale Identity Center session in either tool now shows up as `Token refresh failed: 400 invalid_grant`, and the host drops that credential. |
| Two Kiro providers, or duplicate models | Uninstall `pi-provider-kiro` (`omp plugin uninstall pi-provider-kiro` / `pi remove npm:pi-provider-kiro`), or rerun the installer. |
| pi does not load the extension after a git install | Make sure the install points at `@release/vX.Y.Z`; the plain tag has no `dist/`. |
| Wrong region or profile | Set `KIRO_PROFILE_ARN` to pin a profile. |

## Retry behavior

Generic `429`/`5xx` retries belong to the host. This provider retries only in Kiro-specific cases: `403` credential races (it refreshes from `kiro-cli`), stalled first tokens, empty streams, and `429 USER_REQUEST_RATE_EXCEEDED` with the server's wait hint. Hard quota markers such as `MONTHLY_REQUEST_COUNT` are never retried. The classifiers are exported for consumers:

```ts
import { KIRO_REASON_CODES, isCapacityError, isNonRetryableBodyError, isTooBigError } from "pi-kiro-connect";
```

## Development

```bash
npm ci
npm run check   # type check
npm run lint    # biome
npm test        # vitest
npm run build   # dist/index.js + declarations
```

Each feature lives in its own file under `src/`, with a matching test in `test/`. See [AGENTS.md](AGENTS.md).

### Releasing

1. Bump the version with `npm version <patch|minor|major> --no-git-tag-version` and add a `## [x.y.z]` section to `CHANGELOG.md`.
2. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
3. The [Release workflow](.github/workflows/release.yml) runs check, test and build, pushes `release/vX.Y.Z` with `dist/`, and creates the GitHub Release with the tarball and the installer attached. npm publishing runs only when the repository variable `NPM_PUBLISH` is `true`.

## License

[MIT](LICENSE). Original work © Mikey O'Brien and pi-provider-kiro contributors.
