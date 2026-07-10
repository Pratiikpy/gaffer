/** When the TxLINE client is allowed to mint a new token — and when it must not.
 *
 * Minting signs an on-chain `subscribe` to the TxODDS program with the server keypair. It costs SOL, and
 * that keypair is also the keeper's settler, the faucet, and the wallet whose signature the whole data
 * feed depends on. So the rule is narrow: only a 401 means "your token is no good."
 *
 * It was 401-or-403 for a while. A fixture whose history has aged out of the feed answers 403 forever,
 * so every keeper sweep of a dead pool signed a fresh subscription — two landed in four minutes before it
 * was caught on-chain. A 403 is about the *resource*; authentication is about the *caller*.
 *
 * Mirrors src/lib/txline.ts. Run: `node scripts/test-txline-auth.mjs`
 */
let n = 0, pass = 0;
const t = (name, ok, extra = "") => { n++; if (ok) { pass++; console.log("  ✓", name); } else console.log("  ✗", name, extra); };

const MINT_COOLDOWN_MS = 5 * 60_000;

/** A miniature of the client: token acquisition, the 401-only retry, and the mint cooldown. */
function makeClient({ now = () => 0 } = {}) {
  let token = "stored";
  let mints = 0;
  let lastMintAt = -Infinity;
  let inflight = null;

  const authenticate = async () => { mints++; token = `minted-${mints}`; };

  const renew = async () => {
    if (now() - lastMintAt < MINT_COOLDOWN_MS) return;      // too soon — let the call fail
    if (!inflight) {
      inflight = (async () => { lastMintAt = now(); await authenticate(); })().finally(() => { inflight = null; });
    }
    await inflight;
  };

  /** `fn` receives the current token and may throw `{ response: { status } }`. */
  const withToken = async (fn) => {
    try { return await fn(token); }
    catch (e) {
      if (e?.response?.status !== 401) throw e;
      await renew();
      return await fn(token);
    }
  };

  return { withToken, mints: () => mints, token: () => token };
}

const httpErr = (status) => Object.assign(new Error(`status ${status}`), { response: { status } });

console.log("a 403 is about the resource, not the caller:");
{
  const c = makeClient();
  let threw = false;
  // A fixture whose history has aged out. This 403s forever.
  try { await c.withToken(async () => { throw httpErr(403); }); } catch { threw = true; }
  t("a 403 propagates to the caller", threw);
  t("and mints nothing", c.mints() === 0);
}
{
  const c = makeClient();
  // The keeper sweeping twelve dead pools, as it actually does.
  for (let i = 0; i < 12; i++) { try { await c.withToken(async () => { throw httpErr(403); }); } catch { /* expected */ } }
  t("twelve dead-fixture sweeps sign zero subscriptions", c.mints() === 0);
}

console.log("a 401 is the only thing that mints:");
{
  const c = makeClient();
  let calls = 0;
  const out = await c.withToken(async (tok) => {
    calls++;
    if (calls === 1) throw httpErr(401);   // the stored token had expired
    return `ok with ${tok}`;
  });
  t("one 401 mints exactly once", c.mints() === 1);
  t("and the call is retried with the new token", out === "ok with minted-1");
  t("the retry happens exactly once", calls === 2);
}
{
  const c = makeClient();
  let threw = false;
  // A feed that 401s no matter what must not be retried forever.
  try { await c.withToken(async () => { throw httpErr(401); }); } catch { threw = true; }
  t("a second 401 after minting surfaces the failure", threw);
  t("and it minted only once", c.mints() === 1);
}

console.log("other failures never mint:");
{
  for (const status of [400, 404, 429, 500, 502, 503]) {
    const c = makeClient();
    try { await c.withToken(async () => { throw httpErr(status); }); } catch { /* expected */ }
    t(`a ${status} mints nothing`, c.mints() === 0);
  }
  const c = makeClient();
  try { await c.withToken(async () => { throw new Error("socket hang up"); }); } catch { /* expected */ }
  t("a network error with no response mints nothing", c.mints() === 0);
}

console.log("the cooldown stops a broken feed from emptying the wallet:");
{
  let clock = 0;
  const c = makeClient({ now: () => clock });
  // Every call 401s. Without a cooldown this signs one subscription per sweep, forever.
  for (let i = 0; i < 20; i++) {
    clock += 30_000;                                  // a keeper tick
    try { await c.withToken(async () => { throw httpErr(401); }); } catch { /* expected */ }
  }
  t("twenty minutes of hard 401s mint at most twice", c.mints() <= 2, `minted ${c.mints()}`);

  clock += MINT_COOLDOWN_MS + 1;                      // past the cooldown
  const before = c.mints();
  try { await c.withToken(async () => { throw httpErr(401); }); } catch { /* expected */ }
  t("once the cooldown lapses a genuine expiry can still mint", c.mints() === before + 1);
}

console.log("concurrent 401s collapse into one subscription:");
{
  const c = makeClient();
  let first = true;
  const call = () => c.withToken(async (tok) => {
    if (first) { first = false; throw httpErr(401); }
    if (tok === "stored") throw httpErr(401);
    return tok;
  });
  await Promise.allSettled([call(), call(), call(), call()]);
  t("four in-flight calls sign one subscription, not four", c.mints() === 1, `minted ${c.mints()}`);
}

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
