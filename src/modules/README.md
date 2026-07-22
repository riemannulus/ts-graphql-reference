# `src/modules`

Each feature module owns one vertical slice of the domain: its Prisma access
(`*.repo.ts`), its pure core (`*.core.ts` / value + state files), its service
use-cases (`*.service.ts`), and its delivery layer — GraphQL `schemas/` or, for
`auth`, HTTP `routes/`. The per-module blueprint and the layer rules live in
[CONVENTIONS.md](../../CONVENTIONS.md); this file is about how the modules
depend on **each other**.

## Module dependency graph

![Module dependency graph](./dependency-graph.svg)

Every arrow above is a sanctioned cross-module dependency — and there are no
others. The edges form a DAG by construction (`user` and `post` never point
back), so a module-level import cycle can only appear by editing the allowlist
in [`.dependency-cruiser.mjs`](../../.dependency-cruiser.mjs), which is the
review point. This is the whole allowlist (CONVENTIONS §5, "module services
depend one way only"):

| Edge | Why | Kind |
| --- | --- | --- |
| `onboarding → user`, `onboarding → post` | the cross-module use-case composes both modules' repo functions inside one transaction | value |
| `search → post` | search hydrates external-index hits (ids) through the post repo | value |
| `auth → user` | auth provisions / looks up a user, but the user service is **injected** (wired in `createServices`); importing values would bypass that seam, so this edge is `import type` only | type-only |

`user`, `post`, `point`, and `feature-flag` import no other module. The open
arrowhead on `auth → user` marks the type-only edge (erased at compile time);
solid arrowheads are runtime value imports.

<details>
<summary>File-level dependency graph (every file under <code>src/modules</code>)</summary>

![Module file-level dependency graph](./dependency-graph-detail.svg)

</details>

## Regenerating

Both images are checked-in SVGs produced by
[dependency-cruiser](https://github.com/sverweij/dependency-cruiser) and
[Graphviz](https://graphviz.org/) (`dot` must be on `PATH`):

```sh
pnpm graph:modules
```

The overview collapses each `src/modules/<name>/` folder to a single node; the
detail graph keeps every file. The graph **shape** — no runtime cycles and the
cross-module allowlist above — is enforced in CI by `pnpm check:graph`.
