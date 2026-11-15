/**
 * Creates the single Admin user.
 *
 *   npm run create-admin -- --username admin --name "Admin Name" [--device A]
 *
 * The password is read from ADMIN_PASSWORD if set, otherwise asked for (hidden) in the terminal.
 */
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { writeAudit } from '../src/common/audit.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { withTransaction } from '../src/db/transaction.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { ensureSettings } from '../src/modules/settings/settings.service.js';
import { User } from '../src/modules/users/users.model.js';
import { deviceCode, fullName, newPassword, username } from '../src/modules/users/users.schemas.js';

/* eslint-disable no-console -- CLI output */

function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    throw new Error('No terminal to ask for the password. Set ADMIN_PASSWORD instead.');
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function askPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const first = await readHidden('Password: ');
  const second = await readHidden('Repeat password: ');
  if (first !== second) throw new Error('Passwords do not match.');
  return first;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      name: { type: 'string' },
      device: { type: 'string', default: 'A' },
    },
  });

  const input = {
    username: username.parse(values.username),
    fullName: fullName.parse(values.name),
    deviceCode: deviceCode.parse(values.device),
    password: newPassword.parse(await askPassword()),
  };

  await connectDb(env.MONGODB_URI);
  try {
    await ensureSettings();
    if (await User.exists({ role: 'ADMIN' })) {
      throw new Error('An Admin user already exists. There can be only one.');
    }
    const passwordHash = await hashPassword(input.password);
    const admin = await withTransaction(async (session) => {
      const [created] = await User.create(
        [
          {
            fullName: input.fullName,
            username: input.username,
            passwordHash,
            role: 'ADMIN',
            deviceCode: input.deviceCode,
            createdBy: 'system',
          },
        ],
        { session },
      );
      if (!created) throw new Error('Admin was not created');
      await writeAudit(session, {
        action: 'USER_CREATE',
        userId: null,
        entity: 'user',
        entityId: created._id,
        after: { username: created.username, role: 'ADMIN', deviceCode: created.deviceCode },
        reason: 'Created with scripts/create-admin.ts',
      });
      return created;
    });
    console.log(`Admin "${admin.username}" created (device ${admin.deviceCode}).`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
