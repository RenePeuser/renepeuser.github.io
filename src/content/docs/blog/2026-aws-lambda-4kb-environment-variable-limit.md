---
title: AWS Lambda's 4 KB environment variable limit, and where your configuration belongs instead
date: 2026-11-25
draft: true
authors: rene
tags: [aws, configuration, dotnet, aspnetcore]
excerpt: Sixty environment variables with long names and ARNs, and the Lambda deployment fails because all of them together exceed 4 KB. Why the limit hits .NET apps early, how to move configuration to SSM Parameter Store without changing a single IOptions class, and how to keep the budget in check.
---

:::note[Series]
Part of the series [*Cloud, DevOps & observability*](/series/cloud-devops-observability/).
:::

.NET configuration maps environment variables so naturally that it's easy to put everything there.
`ProjectSettings__Cognito__UserPoolId`, `ProjectSettings__Backend__ClientSecretArn`,
`Logging__LogLevel__Microsoft.AspNetCore`. It works great on ECS, on App Service, in Kubernetes. Then
you deploy the same API as an AWS Lambda function, and the deployment fails:

```text
Lambda was unable to configure your environment variables because the environment variables
you have provided exceeded the 4KB limit.
```

In one platform I worked on, a Minimal API on Lambda hit exactly that. The configuration didn't
feel big: service endpoints, a few IAM role ARNs, Cognito settings, OpenAPI metadata, identifiers for
resources in other clouds, some feature switches. About **60 variables averaging 120 to 130 bytes**
each. That's around **7.5 KB, almost twice the limit**.

## The limit, precisely

AWS Lambda allows **4 KB for all environment variables of a function combined**. Some details that
make it tighter than it sounds:

- It's measured in **bytes**, so non-ASCII characters count more than once.
- **Names count as much as values.** And .NET's hierarchical names are long. The prefix
  `ProjectSettings__` alone is 17 bytes, repeated on every variable.
- ARNs are long. `arn:aws:secretsmanager:eu-central-1:123456789012:secret:shop/orders/backend-client-AbCdEf`
  is over 90 bytes before you add the variable name.
- There's no partial success. One byte over, and the whole update is rejected.

Names can easily be a third or more of the total. Shorten them and you buy some time, but not a
solution.

## What environment variables are good for

Environment variables are perfect for **bootstrap values**: small, few, needed before anything else can
be loaded.

| Good in environment variables | Better somewhere else |
|---|---|
| `ASPNETCORE_ENVIRONMENT` / `DOTNET_ENVIRONMENT` | JSON blobs |
| A log level override | Long URLs and ARNs |
| Region | Secrets (always) |
| **A pointer to the real configuration** | OpenAPI metadata, descriptions |
| A kill switch | Anything with a repeated long prefix |

The last row on the left is the key. Lambda needs to know **where** its configuration is, not what it is.

## Where it belongs: SSM Parameter Store

AWS Systems Manager Parameter Store is built for this:

- Hierarchical paths (`/shop/orders-api/prod/...`) that map directly onto .NET configuration keys.
- IAM-scoped access per path, and `SecureString` parameters encrypted with KMS.
- Standard parameters are free. Each value can be up to 4 KB (advanced parameters: 8 KB), and the number
  of parameters is effectively not your problem.
- An official .NET configuration provider.

The resulting layout:

```text
Lambda function
├── Environment variables (bootstrap only, < 200 bytes)
│   ├── ASPNETCORE_ENVIRONMENT=Production
│   └── CONFIG_PATH=/shop/orders-api/prod
├── SSM Parameter Store  →  application configuration
│   /shop/orders-api/prod/Logging/LogLevel/Default
│   /shop/orders-api/prod/ProjectSettings/ProjectId
│   /shop/orders-api/prod/ProjectSettings/Cognito/UserPoolId
│   /shop/orders-api/prod/ProjectSettings/Backend/ClientSecretArn
└── Secrets Manager  →  credentials, referenced by ARN from SSM
```

The provider maps `/` to `:`, so `/shop/orders-api/prod/ProjectSettings/Cognito/UserPoolId` becomes the
configuration key `ProjectSettings:Cognito:UserPoolId`. Your options classes don't change at all.

## The code

```bash
dotnet add package Amazon.Extensions.Configuration.SystemsManager
```

```csharp
var builder = WebApplication.CreateSlimBuilder(args);

builder.Services.AddAWSLambdaHosting(LambdaEventSource.HttpApi);

var configPath = builder.Configuration["CONFIG_PATH"]
    ?? throw new InvalidOperationException("CONFIG_PATH is not set.");

builder.Configuration.AddSystemsManager(options =>
{
    options.Path = configPath;
    options.Optional = false;                       // fail fast if the path is wrong
    options.ReloadAfter = TimeSpan.FromMinutes(5);  // pick up changes without a redeploy
});
builder.Configuration.AddEnvironmentVariables();    // optional: let env vars override SSM for hotfixes

builder.Services.AddOptions<ProjectSettings>()
    .BindConfiguration("ProjectSettings")
    .ValidateDataAnnotations()
    .ValidateOnStart();

var app = builder.Build();
// ...
app.Run();
```

```csharp
public sealed class ProjectSettings
{
    [Required] public required string ProjectId { get; init; }
    [Required] public required string IamRoleName { get; init; }
    [Required] public required CognitoSettings Cognito { get; init; }
    [Required] public required string BackendClientSecretArn { get; init; }
}
```

Two things I'd insist on:

- **`Optional = false`.** If the path is wrong or the role can't read it, the function should fail at
  startup with a clear error, not run with half a configuration.
- **`ValidateOnStart()`.** Missing settings are found during the cold start of the first instance, not in
  the first request that happens to need them. The original code had a separate "try get, fall back to
  defaults" variant for optional settings. That's fine for truly optional features, but make the choice
  per setting, deliberately. A silent default for a required ARN is a production incident waiting to
  happen.

## "Isn't SSM slow?"

That was the first objection in the team, and it's a fair question. Here's how it behaves:

| | Environment variables | SSM via configuration provider |
|---|---|---|
| Cold start | in memory | one `GetParametersByPath` call (paged), typically tens of ms |
| Warm invocation | in memory | in memory (cached in `IConfiguration`) |
| Per request | 0 | 0 |
| Change without redeploy | ❌ | ✅ with `ReloadAfter` |

The provider loads all parameters under the path **once at startup** and keeps them in the normal
configuration system. After that, reading `IOptions<ProjectSettings>` costs exactly the same as with
environment variables. On a .NET Lambda, where a cold start already takes hundreds of milliseconds, one
extra API call isn't what you'll be optimizing.

If cold starts matter a lot, you can combine it with SnapStart (the parameters are loaded before the
snapshot) or use the *AWS Parameters and Secrets Lambda Extension*, which caches values in a local
sidecar.

## Permissions

```csharp
// CDK: allow the function to read exactly its own path
function.AddToRolePolicy(new PolicyStatement(new PolicyStatementProps
{
    Actions = ["ssm:GetParametersByPath"],
    Resources = [$"arn:aws:ssm:{Region}:{Account}:parameter/shop/orders-api/{stage}*"],
}));
configKey.GrantDecrypt(function);   // only if you use SecureString with a customer-managed key
```

The provider uses `GetParametersByPath`, not `GetParameter`, so that's the action to allow. Scope it to
the path. A wildcard on `parameter/*` gives every function access to every other service's
configuration.

## Comparison

| | Env vars | SSM Parameter Store | Secrets Manager | AppConfig |
|---|---|---|---|---|
| Size | 4 KB total | 4 KB / 8 KB per value | 64 KB per secret | large documents |
| Structure | flat | hierarchical | per secret | documents |
| Secrets | ❌ | `SecureString` | ✅ rotation built in | ❌ |
| Cost | free | standard tier free | per secret per month | per request |
| Feature flags, gradual rollout | ❌ | ❌ | ❌ | ✅ |
| Good for | bootstrap | app configuration | credentials | flags, dynamic config |

## Pitfalls

- **Throttling on mass cold starts.** If hundreds of instances start at once (a traffic spike, a deploy
  of many functions), they all call SSM at the same time. The default throughput is limited. Enable
  *higher throughput* for Parameter Store in busy accounts, keep the number of parameters per path
  reasonable, and make sure retries are on (they are by default in the AWS SDK).
- **Secrets in SSM plain `String` parameters.** Use `SecureString`, or better, keep secrets in Secrets
  Manager and store only the ARN in SSM.
- **`ReloadAfter` and a frozen Lambda.** The reload timer only runs while the instance is active. A
  change shows up "within the interval, while warm". Don't build anything that needs immediate
  consistency on top of it.
- **Different values per environment hidden in code.** The path contains the stage. Don't add
  `if (env.IsProduction())` branches for things that should be parameters.
- **Provider order.** The last registered source wins. That's why the code above adds environment
  variables again *after* SSM: during a migration, or for an emergency override, a single variable can
  still win over a parameter. Leave that line out if you want SSM to be the only truth.

## Keep the budget in check

Even with SSM, the environment variables will creep back. Somebody adds "just one quick setting". A
unit test on the infrastructure code catches it before deployment:

```csharp
[TestMethod]
public void Lambda_environment_stays_well_below_the_4KB_limit()
{
    var app = new App();
    var stack = new OrdersApiStack(app, "Test", new OrdersApiStackProps { Stage = "prod" });
    var template = Template.FromStack(stack);

    var functions = template.FindResources("AWS::Lambda::Function");
    foreach (var (name, resource) in functions)
    {
        var variables = JsonSerializer.SerializeToElement(resource)
            .GetProperty("Properties").GetProperty("Environment").GetProperty("Variables");

        var bytes = variables.EnumerateObject()
            .Sum(v => Encoding.UTF8.GetByteCount(v.Name) + Encoding.UTF8.GetByteCount(v.Value.ToString()));

        Assert.IsTrue(bytes < 1024, $"{name} uses {bytes} bytes of environment variables. Move settings to SSM.");
    }
}
```

A budget of 1 KB instead of 4 KB leaves room for variables that AWS tooling adds and makes the rule
clear: environment variables are for bootstrap, not for configuration.

## Summary

- Lambda allows **4 KB of environment variables per function, names included**. .NET's hierarchical
  names use it up fast.
- Use environment variables for **bootstrap only**: the environment name and a pointer to the
  configuration path.
- Put application configuration in **SSM Parameter Store** with `AddSystemsManager`. Your `IOptions`
  classes don't change.
- Performance is a **non-issue**: one call at cold start, then in-memory.
- Use `Optional = false`, `ValidateOnStart()`, path-scoped IAM, `SecureString` or Secrets Manager for
  secrets, and a **test that enforces a byte budget**.
