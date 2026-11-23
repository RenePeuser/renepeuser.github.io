---
title: User secrets and client secrets — and why neither belongs in your repo
date: 2026-11-23
authors: rene
tags: [dotnet, aspnetcore, security, configuration]
excerpt: User secrets are not encrypted, client secrets expire on a Friday, and the appsettings.json in your Git history still contains last year's password. Where secrets should live during development and in production, and how to stop needing most of them.
---

:::note[Series]
Part of the series [*ASP.NET Core from the ground up*](/series/aspnetcore-from-the-ground-up/).
:::

Search any company's Git history for `ClientSecret` and you'll find something. Usually it's a
placeholder like `"I am a secret"`. Sometimes it's a real value that was committed "just for a quick
test" three years ago, and deleting it in a later commit didn't remove it from the history.

The previous post was about configuration. This one is about the part of configuration that must
**never** be in a configuration file you commit: secrets. Two kinds show up in every API:

- **Development secrets**: the values a developer needs to run the API locally.
- **Client secrets**: the credentials your API uses to call other services, typically in an OAuth
  client-credentials flow.

## User secrets: what they are and what they aren't

```bash
dotnet user-secrets init
dotnet user-secrets set "Payments:ClientSecret" "dev-only-value"
```

`init` adds a `<UserSecretsId>` to the project file. `set` writes to a JSON file in your user
profile:

```text
Windows:  %APPDATA%\Microsoft\UserSecrets\<UserSecretsId>\secrets.json
Linux/macOS: ~/.microsoft/usersecrets/<UserSecretsId>/secrets.json
```

At runtime, `WebApplication.CreateBuilder` adds this file as a configuration source **only when the
environment is `Development`**. It sits after the `appsettings` files, so it overrides them.

What user secrets **are**: a way to keep developer-specific values out of the repository.

What they **aren't**: a secret store. The file is plain-text JSON, not encrypted. Anything that can
read your profile can read it. Microsoft's own documentation says it's meant for development only.

### A workaround I'd no longer recommend

In one codebase I worked on, developers had to test against several stages from their machines. The
team built a small trick: one user-secrets ID per environment, loaded based on the environment name.

```csharp
// Don't copy this. It works, but it puts every stage's secrets on every laptop.
var id = typeof(Program).Assembly.GetCustomAttribute<UserSecretsIdAttribute>()!.UserSecretsId;
builder.Configuration.AddUserSecrets($"{id}__{builder.Environment.EnvironmentName}");
```

Switching stages without changing code was genuinely convenient, and the team was clear that it was
a temporary solution. The problem is what it implies: **production credentials in plain text on
developer machines.** A stolen laptop or a malicious package with access to the user profile, and
you're rotating everything.

If developers need to run against a real stage, the better answer is to let them authenticate **as
themselves** and read the secrets from the vault at runtime, as shown below.

## Production: a vault, read at startup

The production pattern is boring, and that's good: secrets live in a vault (Azure Key Vault, AWS
Secrets Manager, HashiCorp Vault), and the app reads them at startup through a configuration
provider. For Azure Key Vault:

```bash
dotnet add package Azure.Extensions.AspNetCore.Configuration.Secrets
dotnet add package Azure.Identity
```

```csharp
var builder = WebApplication.CreateBuilder(args);

if (builder.Configuration["KeyVault:Uri"] is { Length: > 0 } vaultUri)
{
    builder.Configuration.AddAzureKeyVault(new Uri(vaultUri), new DefaultAzureCredential());
}
```

Key Vault secret names can't contain `:`, so the provider maps `--` to `:`. A secret named
`Payments--ClientSecret` shows up as `Payments:ClientSecret` and binds into `PaymentsOptions` like
any other setting. The rest of the app doesn't know where the value came from, and that's the point.

`DefaultAzureCredential` tries several credential sources in order. In Azure, it uses the **managed
identity** of the App Service or container. On a developer machine, it uses the Azure CLI or Visual
Studio login. So the same code runs everywhere, a developer with the right role assignment can read
the dev vault, and nobody has a copy of the secret on disk.

:::tip[Pipeline variables are not a vault either]
Secret variables in a CI/CD library are better than a JSON file, but they're readable by anyone who
can edit the pipeline, and they tend to get copied between projects. Use them for the vault URI, not
for the secrets themselves, or link the variable group to the vault.
:::

## Client secrets: the credential you'd rather not have

An API calling another API with OAuth client credentials typically looks like this:

```json
{
  "Payments": {
    "TokenEndpoint": "https://login.example.com/oauth/token",
    "ClientId": "orders-api",
    "ClientSecret": "",
    "Audience": "payments-api"
  }
}
```

`ClientSecret` is empty in the file and comes from the vault at runtime. That's the minimum. But a
client secret has problems that a vault doesn't solve:

- **It expires.** Usually on a weekend, and usually the one nobody tracked.
- **It's a shared password.** Everything that has it can impersonate your API.
- **Rotation needs a deployment** unless you build reload logic.

So the real question is: **can you avoid the secret entirely?**

| Option | Secret to manage | Notes |
|---|---|---|
| Client secret | ✅ yes, expires | Simplest to set up, worst to operate |
| Client certificate | Certificate, expires | Not sent over the wire; still needs rotation |
| Managed identity | ❌ none | Azure resources calling Azure-protected APIs |
| Workload identity federation | ❌ none | Kubernetes, GitHub Actions, other clouds trusting your IdP |

When the identity provider and the platform support it, managed identity or federation removes the
secret from the picture. That's the first thing I check when someone asks where to store a client
secret.

### If you must have one: rotate without downtime

Most identity providers allow **two active secrets per client**. Use that:

1. Create the new secret, store it in the vault as a new version.
2. Restart or refresh the apps so they pick up the new version.
3. Delete the old secret at the provider.

Combine that with an **expiry alert** (Key Vault can emit events before a secret expires), and the
Friday outage goes away.

### Don't fetch a token per request

A related mistake: requesting a fresh token for every outgoing call. Tokens are valid for minutes to
hours. Cache them until shortly before expiry, ideally in a `DelegatingHandler` on the typed client,
so the business code never sees the token logic. Libraries like `Microsoft.Identity.Client` (MSAL)
or `Duende.AccessTokenManagement` do this for you.

## Keeping secrets out of Git

Rules only work if something checks them:

- **Secret scanning** on push: GitHub push protection, Azure DevOps advanced security, or
  [gitleaks](https://github.com/gitleaks/gitleaks) as a pre-commit hook and pipeline step.
- **Empty placeholders** in `appsettings.json` for every secret key, so the structure is visible but
  the value isn't.
- **`ValidateOnStart`** with `[Required]` on secret properties, from the previous post, so a missing
  vault entry fails at startup.
- **If a secret was committed, rotate it.** Rewriting history doesn't help if someone has cloned the
  repo in the meantime. Treat it as leaked.

## Pitfalls

**Logging the configuration.** A debug endpoint or startup log that dumps `IConfiguration` dumps the
secrets with it. If you need a configuration overview, log keys and sources, never values.

**Secrets in connection strings in `appsettings.Development.json`.** Local databases with local
passwords are fine. A shared dev database password isn't, because the file gets committed.

**Forgetting the environment.** User secrets aren't loaded outside `Development`. If a value "works
on my machine" and is missing on the test server, check whether it only ever existed in your user
secrets.

## Summary

- **User secrets** keep development values out of Git. They're **plain text** and for development
  only.
- Don't put **every stage's secrets on every laptop**. Let developers read the vault with their own
  identity instead.
- In production, read secrets from a **vault through a configuration provider**, authenticated with
  **managed identity**.
- The best client secret is **no client secret**: prefer managed identity or workload identity
  federation.
- If you need one, **rotate with two active secrets**, alert on expiry, and **cache tokens**.
- **Scan for secrets** on every push, and rotate anything that ever got committed.

*Previous: [Configuration and the Options pattern](/blog/2026-configuration-and-the-options-pattern/) ·
Next: [Authentication basics with JWT bearer tokens](/blog/2026-jwt-bearer-authentication-basics/)*
