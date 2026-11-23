---
draft: true
title: "Is my code really deployed? Inspecting ECS container images locally"
date: 2026-11-23
authors: rene
tags: [aws, containers, devops, tooling]
excerpt: The pipeline is green, the fix doesn't work, and everyone suspects the deployment. How to find out which image an ECS service is actually running, pull it from ECR, look inside without starting it, and make the answer a one-liner next time.
---


Every team has had this conversation. The bug fix is merged, the pipeline is green, the deployment says
"succeeded", and the bug is still there. Is the fix wrong? Did the deployment pick up an old image? Is
there a cached layer with old code? Is one of three tasks still on the previous version?

In one AWS-based platform I worked on, this question came up often enough that the team documented the
answer: pull the exact image from ECR, run it locally, open the files and decompile the DLL to check
whether the change is in there. That works, and it's the right last resort. This post covers that
procedure, cleaned up, and then the things that make it unnecessary most of the time.

## Step 0: which image is actually running?

Before pulling anything, find out what ECS is running. Not what the task definition says, what the
**tasks** are running. A tag like `latest` or even a commit SHA can be overwritten. The **digest** can't.

```bash
aws ecs list-tasks --cluster shop-prod --service-name orders-api \
  --query 'taskArns' --output text \
| xargs aws ecs describe-tasks --cluster shop-prod --tasks \
  --query 'tasks[].{task: taskArn, started: startedAt, image: containers[0].image, digest: containers[0].imageDigest}' \
  --output table
```

If the tasks show different digests, you've found your answer already: a deployment that didn't
finish, or a service that's still draining old tasks. If they all show the same digest, compare it with
what the pipeline pushed:

```bash
aws ecr describe-images --repository-name orders-api \
  --query 'reverse(sort_by(imageDetails, &imagePushedAt))[:5].{tags: imageTags, digest: imageDigest, pushed: imagePushedAt}' \
  --output table
```

Same digest as the latest push? Then the image is deployed, and the question becomes "is my code in
that image?"

## Step 1: log in to ECR

```bash
aws ecr get-login-password --region eu-central-1 --profile shop-prod-readonly \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.eu-central-1.amazonaws.com
```

Use a **read-only** profile for this. Pulling an image needs `ecr:GetAuthorizationToken`,
`ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer`. Nothing else.

## Step 2: pull by digest

```bash
docker pull 123456789012.dkr.ecr.eu-central-1.amazonaws.com/orders-api@sha256:7c41e09b2d3a...
```

Pulling **by digest** guarantees you get exactly what ECS runs, even if someone pushed a new image with
the same tag in the meantime.

If production runs on ARM64 and your laptop is x64 (or the other way around), add
`--platform linux/arm64`. Docker pulls the right variant and, if needed, emulates it. For looking at
files, emulation doesn't matter.

## Step 3: look inside without running it

The original guide ran the container (`docker run -d ...`) and then opened a shell in it. That works,
but it starts the application, which will try to connect to databases, read secrets and generally fail
or, worse, succeed against something real. For inspection, you don't need to start it at all:

```bash
# Create a container from the image without starting it
docker create --name orders-inspect 123456789012.dkr.ecr.eu-central-1.amazonaws.com/orders-api@sha256:7c41e09b2d3a...

# Copy the application folder to your machine
docker cp orders-inspect:/app ./orders-image-app

# Clean up
docker rm orders-inspect
```

Now you have the exact files from production on your disk. If you do want a shell, override the
entrypoint so the app never starts:

```bash
docker run --rm -it --entrypoint /bin/sh 123456789012.dkr.ecr.eu-central-1.amazonaws.com/orders-api@sha256:7c41e09b2d3a...
```

(Alpine and chiseled images don't have `bash`. Chiseled images don't even have `sh`. That's what
`docker cp` is for.)

Docker Desktop shows the same thing with a UI: *Containers → your container → Files* lets you browse
and save files with a right-click. Fine for a quick look.

## Step 4: check whether your change is in there

The team's guide ended with: open the DLL in a decompiler (ILSpy, dotPeek, dnSpy) and compare the code
with what you expect. That's the final proof, and sometimes you need it.

Most of the time, there's a much faster check: the **version stamped into the assembly**. Since
.NET 8, the SDK appends the commit SHA to the informational version automatically when the build runs
in a git repository with Source Link:

```bash
# inside the copied folder, with any .NET SDK installed
strings ./orders-image-app/MyShop.Orders.Api.dll | grep -E '^[0-9]+\.[0-9]+\.[0-9]+.*\+[0-9a-f]{7,}'
# 1.4.0+5e7a19c0d4f2...
```

Or read it properly in a small script:

```csharp
// dotnet run version.cs -- ./orders-image-app/MyShop.Orders.Api.dll   (.NET 10 file-based app)
using System.Diagnostics;

var info = FileVersionInfo.GetVersionInfo(args[0]);
Console.WriteLine($"{info.ProductName} {info.ProductVersion}");
```

`ProductVersion` holds the informational version, including the `+<sha>` suffix. Compare that SHA with
your merge commit. If it matches and the bug is still there, the bug is in the code, not the deployment.

## Make the answer a one-liner

Pulling images and decompiling DLLs is a last resort. With three small changes, the question "what's
running?" answers itself.

**1. Label the image with the commit.** OCI labels are free and survive every registry:

```dockerfile
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.source="https://github.com/my-org/shop-backend"
```

```bash
docker buildx build --build-arg GIT_SHA=$(git rev-parse HEAD) ...
docker image inspect orders-api --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

With `dotnet publish -t:PublishContainer`, the SDK adds these labels for you.

**2. Never deploy mutable tags.** Tag images with the commit SHA and deploy that tag or, better, the
digest. `latest` in a task definition means "whatever was pushed last", which is exactly the ambiguity
you're trying to remove.

**3. Expose the version at runtime.**

```csharp
app.MapGet("/version", () =>
{
    var assembly = typeof(Program).Assembly;
    return new
    {
        Version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
        Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
        StartedAt = Process.GetCurrentProcess().StartTime.ToUniversalTime(),
    };
}).AllowAnonymous().ExcludeFromDescription();
```

Also put the version into your telemetry as `service.version` (OpenTelemetry sets it from the
informational version if you configure the resource with `AddService(serviceName, serviceVersion: ...)`).
Then you can see in your traces, per request, which version served it. During a rolling deployment
that's gold.

## When you need to look at a running container

Sometimes the question is about runtime state: environment variables, mounted files, what the process
sees. For that, use **ECS Exec** instead of reproducing the environment locally:

```bash
aws ecs execute-command --cluster shop-prod --task <task-id> \
  --container orders-api --interactive --command "/bin/sh"
```

It requires `enableExecuteCommand` on the service and the SSM permissions on the task role. Treat it like
SSH into production: allowed for a few people, logged, and not a replacement for proper telemetry.

## Comparison

| Question | Fastest answer |
|---|---|
| Which image are the tasks running? | `aws ecs describe-tasks` → `imageDigest` |
| Is it the image the pipeline pushed? | Compare with `aws ecr describe-images` |
| Which commit is in the image? | OCI label `org.opencontainers.image.revision` |
| Which commit is the running process? | `/version` endpoint, `service.version` in telemetry |
| Does the DLL contain my change? | `docker create` + `docker cp`, then a decompiler |
| What does the process see at runtime? | ECS Exec |

## Pitfalls

- **Running the image locally to inspect it.** It may connect to real resources with whatever config
  is baked in. Use `docker create` and `docker cp`.
- **Pulling by tag.** The tag may have moved. Pull by digest.
- **Production credentials on a laptop.** Use a read-only role for ECR, and delete the image afterwards
  if it contains anything sensitive (it shouldn't, but check `docker history` once).
- **Assuming one task = all tasks.** During and after deployments, check every task.
- **Debug symbols.** Decompiled release code with optimizations is harder to read. That's fine for
  "is my change there?", not for line-by-line debugging.

## Summary

- Start with **what ECS is running**: task image digests, not task definition tags.
- Pull **by digest**, then inspect with **`docker create` + `docker cp`** instead of starting the app.
- Check the **informational version** (`1.4.0+<sha>`) before reaching for a decompiler.
- Make it trivial next time: **OCI revision labels**, **immutable SHA tags**, a **`/version` endpoint** and
  `service.version` in telemetry.
- For runtime questions, use **ECS Exec**, carefully.
