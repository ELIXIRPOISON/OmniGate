import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';
import { loadDotenv } from '../config/dotenv.js';

/**
 * Mint an HS256 token signed with JWT_SECRET for local demos:
 *   pnpm --filter @omnigate/gateway mint-jwt -- --sub alice --scope "orders:read" --exp 1h
 */
loadDotenv();

// pnpm forwards the `--` separator itself (`pnpm mint-jwt -- --sub x`), so drop it before parsing.
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();

const { values } = parseArgs({
  args: argv,
  options: {
    sub: { type: 'string', default: 'demo-user' },
    scope: { type: 'string', default: '' },
    exp: { type: 'string', default: '1h' },
    secret: { type: 'string' },
  },
});

const secret = values.secret ?? process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is not set (and --secret was not given)');
  process.exit(1);
}

const token = await new SignJWT({ scope: values.scope })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setSubject(values.sub)
  .setIssuedAt()
  .setExpirationTime(values.exp)
  .sign(new TextEncoder().encode(secret));

console.log(token);
