import type { AgendaBackend, JobRepository } from 'agenda';

/**
 * A no-op `AgendaBackend` for tests that build a scheduler WITHOUT starting it.
 * agenda's constructor reads `.repository` and calls `.connect()`, but DEFINING
 * handlers and collecting schedules never touch the repository — only
 * `start()` / `every()` / `purge()` do, which these tests do not call (PGlite
 * cannot run agenda's real `pg` LISTEN/NOTIFY, so the backend is the injection
 * seam, exactly like the OAuth / search stubs). The repository is therefore an
 * unimplemented proxy: any method reached throws loudly, so a test that wrongly
 * starts the scheduler fails with a clear message instead of hanging.
 */
export function fakeAgendaBackend(): AgendaBackend {
  const repository = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(
            'fakeAgendaBackend: repository is unimplemented — do not start() the scheduler in tests',
          );
        };
      },
    },
  ) as unknown as JobRepository;

  return {
    name: 'Fake',
    repository,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
  };
}
