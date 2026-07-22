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
      from: { path: '^src/(modules|db|flags|foundation|graphql|scheduler)/' },
      to: { path: '^src/(app|services|server)\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'date-lib-lives-in-time-only',
      comment:
        'A date library is wrapped in ONE place (foundation/time.ts) so a swap ' +
        '(dayjs → Temporal) is a one-file change and no call site knows which ' +
        'library computed a calendar answer. crepe imports dayjs in ~80 files ' +
        'and monkey-patches its prototype; the refactor collapses that to this ' +
        'seam. The layer lint keeps date libs out of cores/repos/etc.; this rule ' +
        'keeps them out of the SHELL too (services, schema, providers) — only ' +
        'foundation/time.ts may reach one. Matched by name so a NEW date lib ' +
        '(not just dayjs) is fenced the moment it is added; a Temporal migration ' +
        'targets a global, which would instead need a no-restricted-globals entry.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/foundation/time\\.ts$' },
      to: { path: 'node_modules/(dayjs|luxon|moment|date-fns|@js-joda)' },
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
    // Presentation only — styles the `dot` reporter behind `pnpm graph:modules`
    // (the SVGs in src/modules/README.md). Does NOT touch the `err` reporter
    // that `pnpm check:graph` uses, so it cannot change what CI enforces.
    reporterOptions: {
      dot: {
        theme: {
          replace: true,
          graph: {
            bgcolor: 'transparent',
            rankdir: 'LR',
            splines: 'spline',
            fontname: 'Helvetica',
            fontsize: '13',
            nodesep: '0.32',
            ranksep: '0.65',
            pad: '0.25',
            color: '#e2e8f0',
            fontcolor: '#94a3b8',
            fillcolor: '#f8fafc80',
            style: 'rounded,filled',
          },
          node: {
            shape: 'box',
            style: 'rounded,filled',
            height: '0.4',
            margin: '0.22,0.09',
            fontname: 'Helvetica',
            fontsize: '12',
            color: '#cbd5e1',
            fillcolor: '#ffffff',
            fontcolor: '#0f172a',
            penwidth: '1.4',
          },
          edge: {
            color: '#94a3b8',
            penwidth: '1.6',
            arrowhead: 'normal',
            arrowsize: '0.75',
          },
          // Each module gets its own soft fill + matching border so both the
          // collapsed overview and the file-level graph read at a glance.
          modules: [
            { criteria: { source: '^src/modules/user' }, attributes: { fillcolor: '#eff6ff', color: '#3b82f6' } },
            { criteria: { source: '^src/modules/post' }, attributes: { fillcolor: '#f0fdf4', color: '#22c55e' } },
            { criteria: { source: '^src/modules/point' }, attributes: { fillcolor: '#fff7ed', color: '#f97316' } },
            { criteria: { source: '^src/modules/feature-flag' }, attributes: { fillcolor: '#faf5ff', color: '#a855f7' } },
            { criteria: { source: '^src/modules/search' }, attributes: { fillcolor: '#ecfeff', color: '#06b6d4' } },
            { criteria: { source: '^src/modules/auth' }, attributes: { fillcolor: '#fdf2f8', color: '#ec4899' } },
            { criteria: { source: '^src/modules/onboarding' }, attributes: { fillcolor: '#fefce8', color: '#eab308' } },
          ],
          // Edges tinted by their target module; the type-only edge (auth→user)
          // stays dashed with a hollow head so the erased seam is unmistakable.
          dependencies: [
            { criteria: { resolved: '^src/modules/user' }, attributes: { color: '#3b82f6' } },
            { criteria: { resolved: '^src/modules/post' }, attributes: { color: '#22c55e' } },
            { criteria: { resolved: '^src/modules/point' }, attributes: { color: '#f97316' } },
            { criteria: { resolved: '^src/modules/feature-flag' }, attributes: { color: '#a855f7' } },
            { criteria: { resolved: '^src/modules/search' }, attributes: { color: '#06b6d4' } },
            { criteria: { resolved: '^src/modules/auth' }, attributes: { color: '#ec4899' } },
            { criteria: { resolved: '^src/modules/onboarding' }, attributes: { color: '#eab308' } },
            {
              criteria: { dependencyTypes: 'type-only' },
              attributes: { style: 'dashed', arrowhead: 'onormal', penwidth: '1.3' },
            },
          ],
        },
      },
    },
  },
};
