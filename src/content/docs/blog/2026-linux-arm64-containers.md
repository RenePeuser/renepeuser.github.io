---
draft: true
title: Moving .NET containers to Linux ARM64, and the Dockerfile line that silently keeps you on x64
date: 2026-11-23
authors: rene
tags: [containers, dotnet, aws]
excerpt: ARM64 instances are cheaper and .NET runs great on them. The migration is mostly a Dockerfile change, but QEMU crashes, a misplaced --platform and credentials in build arguments make it harder than it should be. A Dockerfile that builds fast and actually produces an ARM64 image.
---


Running .NET services on ARM64 is one of the few infrastructure changes that is close to free money.
AWS Graviton, Azure's Ampere and Cobalt VMs, and Google's Axion instances are priced below comparable
x86 instances, .NET has supported ARM64 as a first-class platform for years, and for typical web APIs
the code doesn't change at all.

In one AWS-based platform I worked on, the team started migrating its ECS services from x64 to ARM64
containers. The application code really didn't change. The **Dockerfile** did, and getting it right
took a few rounds. This post is the version I'd write today, including the two errors the team hit and
one subtle problem in the fix that looked like it worked.

## Why bother

The usual arguments, without the marketing:

- **Price.** ARM64 instances and Fargate ARM64 tasks cost less per vCPU-hour than their x86
  counterparts. AWS Lambda on `arm64` is cheaper per GB-second too.
- **Performance per cost.** For typical ASP.NET Core workloads (JSON, HTTP, database calls), ARM64 cores
  perform comparably. Benchmark your own service before you promise numbers, but in my experience
  nobody has been disappointed.
- **Energy.** ARM64 servers draw less power for the same work. If your organization reports on
  sustainability, this shows up there.
- **Developer machines.** Many developers work on Apple Silicon. Multi-architecture images mean the
  same image runs natively on their laptops and in production.

What can stop you: native dependencies without ARM64 builds (some older database drivers, image
processing libraries, or vendor SDKs with bundled native code). Check your `runtimes/` folder after a
publish. If there's a `linux-x64` folder and no `linux-arm64` next to it, you have homework.

## First: pin the SDK

The first step in that migration was a `global.json`, so local builds, CI and the Docker build all
use the same SDK:

```json
{
  "sdk": {
    "version": "9.0.300",
    "rollForward": "latestPatch"
  }
}
```

Cross-architecture builds touched a few SDK bugs along the way. You want to know which SDK you're on
when you read the release notes.

## The naive Dockerfile and the QEMU crash

The first version built everything for the target platform, and the CI host was x64:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:9.0-alpine AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/MyShop.Orders.Api/MyShop.Orders.Api.csproj -c Release -o /app --runtime linux-arm64

FROM mcr.microsoft.com/dotnet/aspnet:9.0-alpine
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "MyShop.Orders.Api.dll"]
```

```bash
docker buildx build --platform linux/arm64 -t orders-api .
```

With `--platform linux/arm64`, **every** stage runs as ARM64, including the SDK stage. On an x64 host,
Docker runs it through **QEMU emulation**. That's slow (builds take several times longer), and the SDK
under emulation is fragile. The team got this:

```text
ERROR: process "/dev/.buildkit_qemu_emulator /bin/sh -c dotnet build ... --runtime linux-arm64" did not complete successfully
error MSB4018: System.NullReferenceException: Object reference not set to an instance of an object.
   at InvokeStub_CheckIfPackageReferenceShouldBeFrameworkReference.set_FrameworkReferenceToUse(Object, Span`1)
error MSB4026: The "FrameworkReferenceToUse=Microsoft.AspNetCore.App" parameter for the
"CheckIfPackageReferenceShouldBeFrameworkReference" task is invalid.
```

Look at the first line: `buildkit_qemu_emulator`. Whenever you see that in a .NET build error, the answer
is almost never in the error text itself. The answer is: **don't run the SDK under emulation.**

(The second error the team hit was simpler: `docker buildx --platform ...` exits with status 125
because the subcommand is missing. It's `docker buildx build --platform ...`.)

## The fix that looked right

The team's fix was to add `--platform=$BUILDPLATFORM`, and the QEMU error disappeared. But it was added to
the **runtime** stage:

```dockerfile
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/aspnet:9.0-alpine AS base   # <- here
```

That builds without errors, and on an x64 build host it produces an **x64 image**. The `--platform`
on the final stage decides the architecture of the image you ship. Because the published DLLs are
framework-dependent IL, the x64 runtime happily runs them, so nothing fails. You just don't get ARM64,
and an ECS task definition that says `ARM64` then refuses the image (`exec format error`), or the task
runs on x64 and you never get the savings.

Check what you actually built:

```bash
docker buildx imagetools inspect 123456789012.dkr.ecr.eu-central-1.amazonaws.com/orders-api:latest
docker image inspect orders-api --format '{{.Architecture}}'
```

## The Dockerfile I'd use

The pattern Microsoft recommends: the **SDK stage** runs on the build platform (native, fast) and
**cross-compiles** for the target architecture. The **runtime stage** uses the target platform.

```dockerfile
# syntax=docker/dockerfile:1

# Build stage: native on the build machine, cross-compiles for the target
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:9.0-alpine AS build
ARG TARGETARCH
WORKDIR /src

COPY ["global.json", "NuGet.Config", "Directory.Packages.props", "./"]
COPY ["src/MyShop.Orders.Api/MyShop.Orders.Api.csproj", "src/MyShop.Orders.Api/"]
RUN --mount=type=secret,id=nuget_token,env=NUGET_TOKEN \
    dotnet restore "src/MyShop.Orders.Api/MyShop.Orders.Api.csproj" -a $TARGETARCH

COPY . .
RUN dotnet publish "src/MyShop.Orders.Api/MyShop.Orders.Api.csproj" \
    -c Release -a $TARGETARCH --no-restore -o /app/publish

# Runtime stage: the target platform (no --platform here!)
FROM mcr.microsoft.com/dotnet/aspnet:9.0-alpine AS final
RUN apk add --no-cache icu-libs
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
WORKDIR /app
COPY --from=build /app/publish .
USER $APP_UID
ENTRYPOINT ["dotnet", "MyShop.Orders.Api.dll"]
```

What's going on:

- **`--platform=$BUILDPLATFORM` on the SDK stage.** The SDK runs natively. No QEMU, no crash, normal
  build speed.
- **`ARG TARGETARCH` and `-a $TARGETARCH`.** BuildKit sets `TARGETARCH` to `arm64` or `amd64`.
  `dotnet restore` and `publish` with `-a` pick the right runtime identifier (on Alpine,
  `linux-musl-arm64`). Restore and publish must use the same architecture, or `--no-restore` fails.
- **No `--platform` on the runtime stage.** It inherits the target platform from `docker buildx build
  --platform`, so the image really is ARM64.
- **`icu-libs` and `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false`.** The Alpine images run in invariant
  globalization mode by default. If your app formats dates, numbers or currencies per culture, you need
  ICU. If it doesn't, leave invariant mode on and save the space.
- **`USER $APP_UID`.** The .NET 8+ images include a non-root user. Use it. (They also listen on port
  8080 instead of 80 by default, so `EXPOSE 80` from older Dockerfiles is now wrong.)

Build for one or both architectures:

```bash
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --secret id=nuget_token,env=NUGET_TOKEN \
  -t 123456789012.dkr.ecr.eu-central-1.amazonaws.com/orders-api:${GIT_SHA} \
  --push .
```

## Don't pass credentials as build arguments

The original build needed access to a private package feed (AWS CodeArtifact). It assumed a role in the
pipeline and passed the temporary AWS keys into the Docker build:

```bash
docker build --build-arg AWS_ACCESS_KEY_ID=... --build-arg AWS_SECRET_ACCESS_KEY=... --build-arg AWS_SESSION_TOKEN=...
```

Then it installed Python, pip and the AWS CLI **inside the SDK image**, just to run
`aws codeartifact login`. Two problems with that:

1. **Build arguments end up in the image history.** Anyone who can pull the image can run
   `docker history --no-trunc` and read them. Temporary keys expire, but "temporary" can be hours.
2. **It's slow and heavy.** Installing Python and the AWS CLI on every uncached build adds minutes.

Better: get the token **outside** the Docker build, and hand it in as a **BuildKit secret**, which is
mounted only for that one `RUN` step and never stored in a layer.

```bash
export NUGET_TOKEN=$(aws codeartifact get-authorization-token \
  --domain my-domain --domain-owner 123456789012 --query authorizationToken --output text)
```

```xml
<!-- NuGet.Config -->
<configuration>
  <packageSources>
    <add key="internal" value="https://my-domain-123456789012.d.codeartifact.eu-central-1.amazonaws.com/nuget/shop-packages/v3/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <internal>
      <add key="Username" value="aws" />
      <add key="ClearTextPassword" value="%NUGET_TOKEN%" />
    </internal>
  </packageSourceCredentials>
</configuration>
```

NuGet expands `%NUGET_TOKEN%` from the environment, which the `--mount=type=secret,...,env=NUGET_TOKEN`
provides during restore only.

## Or skip the Dockerfile entirely

Since .NET 8, the SDK can build container images without a Dockerfile:

```bash
dotnet publish src/MyShop.Orders.Api -c Release -t:PublishContainer \
  -p:ContainerRuntimeIdentifiers="linux-arm64;linux-x64" \
  -p:ContainerRepository=orders-api \
  -p:ContainerRegistry=123456789012.dkr.ecr.eu-central-1.amazonaws.com
```

No QEMU, no Docker daemon needed, multi-architecture out of the box. It's my default for plain ASP.NET
Core services. Use a Dockerfile when you need extra OS packages or unusual build steps.

## Build natively when you can

Cross-compiling with `$BUILDPLATFORM` avoids emulation for the build. **Running tests** for ARM64 still
needs ARM64 hardware. Options:

- GitHub-hosted ARM64 Linux runners (`ubuntu-24.04-arm`).
- A CodeBuild runner with an ARM image (`image:arm-3.0` in the runs-on label, see
  [GitHub Actions with self-hosted runners](/blog/2026-github-actions-self-hosted-runners/)).
- Developer machines on Apple Silicon, which run `linux/arm64` containers natively.

## Comparison

| Approach | Build speed | Correct ARM64 image | Credentials safe | Effort |
|---|---|---|---|---|
| Everything under QEMU | slow, can crash | ✅ | depends | low |
| `--platform=$BUILDPLATFORM` on the runtime stage | fast | ❌ x64 image | depends | low |
| `$BUILDPLATFORM` on SDK stage + `-a $TARGETARCH` | fast | ✅ | with secrets ✅ | low |
| SDK container publish (`PublishContainer`) | fast | ✅ | ✅ | lowest |
| Native ARM64 runner | fast | ✅ | ✅ | runner setup |

## Pitfalls

- **`--platform=$BUILDPLATFORM` on the wrong stage.** It belongs on the SDK stage only.
- **Restore and publish for different architectures.** `restore -a arm64` and `publish -a arm64`, or
  drop `--no-restore`.
- **Native NuGet dependencies without ARM64 binaries.** Check the publish output for `runtimes/linux-arm64`.
- **`EXPOSE 80` and health checks on port 80.** .NET 8+ images listen on 8080.
- **Task definitions.** In ECS, set `runtimePlatform.cpuArchitecture = ARM64` (and on Fargate,
  `operatingSystemFamily = LINUX`). An image and a task definition that disagree fail with
  `exec format error`.

## Verify it in the pipeline

Add one line after the push, so the wrong architecture never reaches an environment:

```bash
docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest}}' | jq -e \
  '.manifests[] | select(.platform.architecture == "arm64")' > /dev/null \
  || { echo "No arm64 manifest in $IMAGE"; exit 1; }
```

And at runtime, `RuntimeInformation.ProcessArchitecture` in a startup log line or a health endpoint
tells you what's really running.

## Summary

- ARM64 is **cheaper** and .NET runs well on it. For most APIs, only the build changes.
- Never run the SDK under **QEMU**: put `--platform=$BUILDPLATFORM` on the **SDK stage** and cross-compile
  with `-a $TARGETARCH`.
- `--platform=$BUILDPLATFORM` on the **runtime stage** builds an **x64 image** that looks fine. Verify the
  architecture.
- Pass feed credentials as **BuildKit secrets**, never as build arguments.
- Consider **`dotnet publish -t:PublishContainer`**, which handles multi-arch images without a Dockerfile.
