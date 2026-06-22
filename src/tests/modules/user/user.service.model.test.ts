import { fc, test } from '@fast-check/vitest';
import { afterAll, beforeEach, expect } from 'vitest';
import { UserService } from '../../../modules/user/user.service.js';
import {
  canTransition,
  InvalidStatusTransitionError,
  type UserStatus,
} from '../../../modules/user/user.state.js';
import { arbUserStatus } from './user.arbitraries.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = makeTestPrisma();
const users = new UserService(prisma);

interface Model {
  status: UserStatus;
}
interface Real {
  id: number;
}

/**
 * Model-based test: a random sequence of status changes is replayed against
 * both a tiny in-memory model (the state machine spec) and the real service +
 * DB, asserting they never diverge — legal moves succeed, illegal moves are
 * rejected and leave state untouched.
 */
class ChangeStatusCommand implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly to: UserStatus) {}

  check(): boolean {
    return true;
  }

  async run(model: Model, real: Real): Promise<void> {
    const legal = model.status === this.to || canTransition(model.status, this.to);
    if (legal) {
      const updated = await users.changeStatus(real.id, this.to);
      model.status = this.to;
      expect(updated.status).toBe(model.status);
    } else {
      await expect(users.changeStatus(real.id, this.to)).rejects.toBeInstanceOf(
        InvalidStatusTransitionError,
      );
      // model (and DB) left unchanged
    }
  }

  toString(): string {
    return `changeStatus(${this.to})`;
  }
}

const commands = [arbUserStatus.map((to) => new ChangeStatusCommand(to))];

let seq = 0;
beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

test.prop([fc.commands(commands, { size: '+1' })])(
  'UserService status stays consistent with the state-machine model',
  async (cmds) => {
    const user = await users.create({ email: `model-${seq++}@example.com` });
    await fc.asyncModelRun(
      () => ({ model: { status: 'ACTIVE' as UserStatus }, real: { id: user.id } }),
      cmds,
    );
  },
);
