/**
 * Module-graph rules, checked with `pnpm check:graph`.
 *
 * oxlint enforces the LAYER rules (what a file may import — see .oxlintrc.json
 * and CONVENTIONS §1); the rules here enforce the GRAPH SHAPE that the layer
 * rules cannot see:
 *
 * - runtime import cycles (value imports only — `import type` is erased at
 *   compile time and is this codebase's sanctioned cycle breaker: builder.ts
 *   pulls Context as a type only, context.ts pulls Services as a type only);
 * - which module may depend on which (the cross-module allowlist below). The
 *   allowlisted edges — onboarding → {user, post}, search → post,
 *   auth → user (type-only) — form a DAG by construction: user and post fall
 *   under the default ban, so they can never point back. A module-level cycle
 *   can therefore only enter by editing this file, which is the review point.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-runtime-cycles',
      comment:
        'A cycle of VALUE imports is a real runtime cycle. Cycles that only ' +
        'exist through `import type` edges are allowed — types are erased.',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'cross-module-deps-are-allowlisted',
      comment:
        'A module may import another module only when the pair is sanctioned ' +
        'by a rule below (CONVENTIONS §5: module services depend one way ' +
        'only). A new cross-module dependency means extending the allowlist ' +
        'here, where the review can see it.',
      severity: 'error',
      from: {
        path: '^src/modules/([^/]+)/',
        pathNot: '^src/modules/(auth|onboarding|search)/',
      },
      to: { path: '^src/modules/', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'onboarding-reaches-user-and-post-only',
      comment:
        'The cross-module use-case: onboarding composes the user and post ' +
        "modules' repo functions inside one transaction.",
      severity: 'error',
      from: { path: '^src/modules/onboarding/' },
      to: { path: '^src/modules/', pathNot: '^src/modules/(onboarding|user|post)/' },
    },
    {
      name: 'search-reaches-post-only',
      comment: 'Search hydrates external-index hits through the post repo.',
      severity: 'error',
      from: { path: '^src/modules/search/' },
      to: { path: '^src/modules/', pathNot: '^src/modules/(search|post)/' },
    },
    {
      name: 'auth-reaches-user-only',
      severity: 'error',
      from: { path: '^src/modules/auth/' },
      to: { path: '^src/modules/', pathNot: '^src/modules/(auth|user)/' },
    },
    {
      name: 'auth-to-user-is-type-only',
      comment:
        'auth receives the user service INJECTED (wired in createServices); ' +
        'importing user values would bypass that seam. Types are erased, so ' +
        '`import type` is fine.',
      severity: 'error',
      from: { path: '^src/modules/auth/' },
      to: { path: '^src/modules/user/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'composition-root-is-the-top',
      comment:
        'app.ts / services.ts / server.ts assemble everything, so nothing ' +
        'below them may import them as a value. The Services TYPE flowing ' +
        'down into context.ts is the sanctioned (erased) exception.',
      severity: 'error',
      from: { path: '^src/(modules|db|flags|foundation|graphql)/' },
      to: { path: '^src/(app|services|server)\\.ts$', dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Tests import across every module by design; generated code is not ours.
    exclude: { path: ['^src/tests', '^src/generated'] },
    // 'specify' marks dependencies that disappear after compilation as
    // type-only — required for every dependencyTypesNot above.
    tsPreCompilationDeps: 'specify',
    // NodeNext ESM (`.js` specifiers resolving to `.ts` sources) is handled by
    // dependency-cruiser's resolver out of the box, keyed off this tsconfig.
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
