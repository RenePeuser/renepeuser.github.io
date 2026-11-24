// Single source of truth for the blog series.
// Used by astro.config.mjs (sidebar) and by the series components (overview, chapter lists,
// in-post navigation). To add a post to a series, add its slug (file name without .md) to `posts`.

/** @typedef {{ id: string, accent: string, title: string, icon: string, description: string }} SeriesGroup */
/** @typedef {{ slug: string, title: string, group: string, icon: string, description: string, posts: string[], draft?: boolean }} Series */
// A series with `draft: true` (and its page) only shows up in `astro dev`.

/** @type {SeriesGroup[]} */
export const seriesGroups = [
	{
		"id": "build",
		"accent": "#3b9eff",
		"title": "Build APIs",
		"icon": "rocket",
		"description": "Everything you need to build and ship a solid ASP.NET Core API."
	},
	{
		"id": "design",
		"accent": "#a78bfa",
		"title": "Design & architecture",
		"icon": "puzzle",
		"description": "Structuring backends so they stay maintainable, and the traps along the way."
	},
	{
		"id": "quality",
		"accent": "#34d399",
		"title": "Quality",
		"icon": "approve-check-circle",
		"description": "Tests, analyzers and tooling that keep a codebase safe to change."
	},
	{
		"id": "operate",
		"accent": "#f59e0b",
		"title": "Data & operations",
		"icon": "server",
		"description": "Caching, data access, infrastructure and observability."
	},
	{
		"id": "team",
		"accent": "#f472b6",
		"title": "Team & process",
		"icon": "comment-alt",
		"description": "How teams actually work: Scrum, planning and collaboration."
	},
	{
		"id": "oss",
		"accent": "#22d3ee",
		"title": "Open source",
		"icon": "github",
		"description": "My open-source .NET libraries: what they solve, how to use them and why they beat the hand-written alternative."
	},
	{
		"id": "journey",
		"accent": "#94a3b8",
		"title": "Retrospective",
		"icon": "clock",
		"description": "A personal journey through almost two decades of engineering."
	}
];

/** @type {Series[]} */
export const series = [
	{
		"slug": "aspnetcore-from-the-ground-up",
		"title": "ASP.NET Core from the ground up",
		"group": "build",
		"icon": "laptop",
		"description": "Setting up a production-ready ASP.NET Core API step by step — hosting, DI, configuration, security, errors and documentation.",
		"posts": [
			"2026-program-cs-and-the-hosting-model",
			"2026-di-lifetimes-and-service-registration",
			"2026-configuration-and-the-options-pattern",
			"2026-user-secrets-and-client-secrets",
			"2026-jwt-bearer-authentication-basics",
			"2026-cors-done-right",
			"2026-security-filters",
			"2026-global-error-handling-with-problemdetails",
			"2026-error-logging",
			"2026-swagger-and-openapi-setup",
			"2026-a-health-endpoint-that-tells-the-truth",
			"2026-controllers-vs-minimal-apis",
			"2026-no-try-catch-in-endpoints",
			"2026-automatic-dependency-registration"
		]
	},
	{
		"slug": "rest-and-openapi-design",
		"title": "REST & OpenAPI design",
		"group": "build",
		"icon": "link",
		"description": "Designing HTTP APIs that consumers understand and that survive change.",
		"posts": [
			"2026-soft-delete-in-rest-apis",
			"2026-property-updates-vs-action-endpoints",
			"2026-patch-with-json-merge-patch",
			"2026-rereading-raw-json-body-minimal-apis",
			"2026-dotnet-9-openapi-problems-and-fixes",
			"2026-json-polymorphism-discriminators-openapi",
			"2026-extensible-enums-x-extensible-enum",
			"2026-detecting-breaking-changes-with-openapi-diffs",
			"2026-generating-guideline-compliant-openapi"
		]
	},
	{
		"slug": "validation-and-error-handling",
		"title": "Validation & error handling",
		"group": "build",
		"icon": "warning",
		"description": "How to fail well — exception handling, logging and validation strategies for APIs.",
		"posts": [
			"2026-exception-handling-best-practices",
			"2026-logging-exceptions-properly"
		]
	},
	{
		"slug": "architecture-in-practice",
		"title": "Architecture in practice",
		"group": "design",
		"icon": "puzzle",
		"description": "Patterns for structuring .NET backends that hold up in real projects — vertical slices, CQRS, context objects, contracts and the lessons from applying them at scale.",
		"posts": [
			"2026-request-context-builder",
			"2026-vertical-slices",
			"2026-folder-structure-by-feature",
			"2026-anatomy-of-a-minimal-endpoint",
			"2026-mapping-as-anti-corruption-layer",
			"2026-cqrs-with-mediatr-without-ceremony",
			"2026-mediatr-pipeline-behaviors",
			"2026-command-with-several-queries",
			"2026-cost-of-indirection",
			"2026-shared-contracts-library",
			"2026-lightweight-adrs"
		]
	},
	{
		"slug": "dotnet-pitfalls",
		"title": ".NET pitfalls",
		"group": "design",
		"icon": "error",
		"description": "Things that compile, pass review and still break your app — HttpClient, async, nullability and other traps from real projects.",
		"posts": [
			"2026-httpclient-you-are-using-it-wrong",
			"2026-async-await-pitfalls",
			"2026-configureawait-false-explained",
			"2026-iasyncenumerable-done-right",
			"2026-nullability-warnings",
			"2026-equalitycomparer-default",
			"2026-virtual-methods",
			"2026-transactionscope-async",
			"2026-immutable-collections-serialization",
			"2026-sql-in-clause-parameters",
			"2026-startup-time-lazy-registrations"
		]
	},
	{
		"slug": "code-smells-and-their-fixes",
		"title": "Code smells & their fixes",
		"group": "design",
		"icon": "magnifier",
		"description": "Classic C# code smells from real codebases — events, simulation flags, out parameters, null checks, global state — and the modern patterns that replace them.",
		"posts": [
			"2026-code-smells-overview",
			"2026-event-based-apis-to-tasks",
			"2026-producer-consumer-with-channels",
			"2026-taming-high-frequency-events",
			"2026-no-simulation-flags-in-production-code",
			"2026-out-parameters-vs-result-types",
			"2026-null-object-pattern-and-nullable-reference-types",
			"2026-replace-switch-chains-with-strategies",
			"2026-repository-vs-query-object",
			"2026-lazy-and-singletons-done-right",
			"2026-state-is-the-enemy",
			"2026-code-noise"
		]
	},
	{
		"slug": "testing-in-practice",
		"title": "Testing in practice",
		"group": "quality",
		"icon": "approve-check",
		"description": "Integration tests, unit tests and test strategies that keep large APIs safe to change — for humans and AI agents.",
		"posts": [
			"2026-api-integration-test-base-class",
			"2026-api-test-patterns-get-post-delete",
			"2026-test-first-for-apis",
			"2026-from-postman-to-csharp-and-back",
			"2026-testing-against-multiple-environments",
			"2026-testing-with-specific-user-tokens",
			"2026-unit-test-best-practices-and-naming",
			"2026-snapshot-testing-for-graph-logic",
			"2026-ai-friendly-tests",
			"2026-testcontainers",
			"2026-integration-tests-with-background-events"
		]
	},
	{
		"slug": "code-quality-and-tooling",
		"title": "Code quality & tooling",
		"group": "quality",
		"icon": "setting",
		"description": "Build, package and analyzer setup that scales across many repositories.",
		"posts": [
			"2026-central-package-management",
			"2026-directory-build-props",
			"2026-versioning-with-gitversion",
			"2026-source-link",
			"2026-publishing-readytorun",
			"2026-faster-builds-in-large-solutions",
			"2026-creating-nuget-packages",
			"2026-nuget-audit-and-transitive-dependencies",
			"2026-dotnet-global-tools",
			"2026-roslynator-and-analyzers-in-ci",
			"2026-consistent-formatting-locally-and-in-ci",
			"2026-code-review-checklist",
			"2026-codeql-best-practices"
		]
	},
	{
		"slug": "caching-and-data",
		"title": "Caching & data",
		"group": "operate",
		"icon": "database",
		"description": "Redis, caching abstractions and data access without an ORM.",
		"posts": [
			"2026-redis-data-types-in-practice",
			"2026-redis-key-conventions",
			"2026-understanding-redis-timeouts",
			"2026-caching-abstractions-memory-redis-hybrid",
			"2026-query-providers-and-idatareader",
			"2026-dapper-in-practice",
			"2026-the-limits-of-odata-clients"
		]
	},
	{
		"slug": "cloud-devops-observability",
		"title": "Cloud, DevOps & observability",
		"group": "operate",
		"icon": "analytics",
		"description": "Terraform, Azure and finding out what your system is actually doing.",
		"posts": [
			"2026-terraform-errors-and-how-to-fix-them",
			"2026-kql-fundamentals",
			"2026-the-most-used-kql-features",
			"2026-kql-in-azure-alert-rules",
			"2026-grafana-dashboards-with-kql",
			"2026-filtering-application-insights-telemetry",
			"2026-opentelemetry-facade-for-aspnetcore",
			"2026-azure-setup-101",
			"2026-git-reflog-as-a-safety-net"
		]
	},
	{
		"slug": "scrum-in-the-real-world",
		"title": "Scrum in the real world",
		"group": "team",
		"icon": "comment-alt",
		"description": "What remained of Scrum after years with six teams — the practices that worked, and the ones we dropped.",
		"posts": [
			"2026-why-we-abandoned-burndown-charts",
			"2026-realistic-capacity-planning",
			"2026-the-scrum-master-who-made-the-role-redundant",
			"2026-re-forming-teams-with-a-competence-matrix",
			"2026-retrospectives-goods-bads-vs-sailboat",
			"2026-putting-impediments-in-the-managers-path",
			"2026-three-column-board-strict-definition-of-done",
			"2026-when-is-a-bug-a-bug",
			"2026-user-stories-and-acceptance-criteria",
			"2026-estimation-planning-poker-t-shirt-sizes-reference-stories",
			"2026-definition-of-ready"
		]
	},
	{
		"slug": "argument-check",
		"title": "Argument.Check",
		"group": "oss",
		"icon": "github",
		"description": "Guard clauses that cost nothing until they fail and explain themselves when they do.",
		"posts": [
			"2026-argument-check-guard-clauses-in-one-line",
			"2026-argument-check-the-throw-catalogue",
			"2026-argument-check-what-a-guard-costs",
			"2026-argument-check-vs-built-in-guards"
		]
	},
	{
		"slug": "aspnetcore-minimalapi-sdk",
		"draft": true,
		"title": "AspNetCore.MinimalApi.Sdk",
		"group": "oss",
		"icon": "github",
		"description": "A reference blueprint for minimal APIs: endpoint slices, a generated typed client and CLI, and 109 code rules that keep it consistent.",
		"posts": [
			"2026-minimalapi-sdk-a-blueprint-for-minimal-apis",
			"2026-minimalapi-sdk-typed-client-and-cli",
			"2026-minimalapi-sdk-code-rules",
			"2026-minimalapi-sdk-vs-alternatives"
		]
	},
	{
		"slug": "aspnetcore-simple-mstest-sdk",
		"title": "AspNetCore.Simple.MsTest.Sdk",
		"group": "oss",
		"icon": "github",
		"description": "API integration tests in one line: test data in files, whole-response comparison and analyzers that guide you.",
		"posts": [
			"2026-mstest-sdk-api-tests-in-one-line",
			"2026-mstest-sdk-failures-that-explain-themselves",
			"2026-mstest-sdk-fluent-api-and-analyzers",
			"2026-mstest-sdk-vs-hand-written-tests"
		]
	},
	{
		"slug": "solution-parser",
		"title": "Solution.Parser",
		"group": "oss",
		"icon": "github",
		"description": "Code rules everyone can write, as LINQ in a unit test, plus architecture validation for projects, packages and XAML.",
		"posts": [
			"2026-solution-parser-your-solution-as-a-queryable-model",
			"2026-solution-parser-reading-code-like-code",
			"2026-solution-parser-architecture-tests-for-projects-and-xaml",
			"2026-solution-parser-architecture-rules-for-the-whole-solution"
		]
	},
	{
		"slug": "from-vb6-to-self-defending-codebases",
		"title": "From VB6 to self-defending codebases",
		"group": "journey",
		"icon": "clock",
		"description": "A blog series tracing almost two decades of engineering — from VB6 operator interfaces to Roslyn rules, test SDKs and codebases that enforce their own conventions.",
		"posts": [
			"2007-vb6-hmi-roots",
			"2007-first-steps-with-wpf-and-mvvm",
			"2012-hosting-wpf-controls-in-vb6",
			"2013-localizing-wpf-applications",
			"2013-interactive-canvases-in-wpf",
			"2016-reusable-wpf-building-blocks",
			"2016-generating-test-data-and-mocks",
			"2017-roslyn-analyzers-and-argument-checks",
			"2019-testing-the-solution-itself",
			"2021-aspnetcore-simple-mstest-sdk",
			"2024-clientgenerator-runjit-rulejit",
			"2026-self-defending-codebases"
		]
	}
];

/** @param {string} groupId */
export const findGroup = (groupId) => seriesGroups.find((g) => g.id === groupId);

/** @param {string} postSlug */
export const findSeriesForPost = (postSlug) => series.find((s) => s.posts.includes(postSlug));
