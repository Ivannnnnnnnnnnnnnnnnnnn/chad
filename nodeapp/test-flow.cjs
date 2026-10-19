const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8100';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const c = await b.newContext();
  const p = await c.newPage();
  const errors = [];
  const bad = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  // The deliberate wrong-token probe returns 403; ignore that one.
  p.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes(BASE) && !r.url().startsWith('https://')) {
      if (r.status() === 403) return;
      bad.push(`${r.status()} ${r.url()}`);
    }
  });

  // --- pages render ---
  for (const [path, marker] of [['/', 'Statut Réseau'], ['/plans/', 'Choisissez Votre Forfait'], ['/settings/', 'Paramètres']]) {
    const res = await p.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(400);
    const body = await p.locator('body').innerText();
    check(`GET ${path} 200`, res.status() === 200, res.status());
    check(`${path} renders`, body.includes(marker), body.slice(0, 60));
  }

  // --- checkout ---
  await p.goto(BASE + '/plans/', { waitUntil: 'networkidle' });
  const cards = await p.locator('.package-card').count();
  check('plans rendered from server data', cards === 5, `cards=${cards}`);
  await p.locator('.select-plan-btn').first().click();
  await p.waitForTimeout(300);
  check('modal opens', await p.locator('#paymentModal').isVisible());
  await p.locator('.payment-method-btn[data-method="airtel"]').click();
  await p.waitForTimeout(200);
  await p.locator('#phone_number').fill('12345678');
  await p.locator('#phone_number').blur();
  await p.waitForTimeout(300);
  const phoneErr = await p.locator('#phoneError').innerText();
  check('client phone validation from server rules', /commencer par 6, 7 ou 9/.test(phoneErr), phoneErr);

  await p.locator('#phone_number').fill('66123456');
  await Promise.all([
    p.waitForURL(/\/orders\/.+\/pin/, { timeout: 15000 }),
    p.locator('#payBtn').click(),
  ]);
  const flowUrl = p.url();
  const m = flowUrl.match(/\/orders\/([^/]+)\/([^/]+)\/pin/);
  check('checkout -> PIN page', !!m, flowUrl);
  const [, ref, token] = m;

  const pinBody = await p.locator('body').innerText();
  check('PIN page heading', pinBody.includes('Entrez votre code PIN'));
  check('PIN page shows phone', pinBody.includes('66 12 34 56'));
  check('PIN page has 4 boxes', (await p.locator('.pin-box').count()) === 4);

  // --- submit a PIN, nothing is auto-submitted before ---
  const boxes = p.locator('.pin-box');
  for (let i = 0; i < 4; i++) { await boxes.nth(i).fill(''); await boxes.nth(i).type('4821'[i]); }
  await p.waitForTimeout(800);
  check('typing does NOT auto-submit', /\/pin/.test(p.url()), p.url());

  await p.locator('#verifySubmit').click();
  await p.waitForTimeout(1200);
  await p.waitForSelector('#waitingBanner:not(.hidden)', { timeout: 8000 }).catch(() => {});
  check('after submit: still on PIN page', /\/pin/.test(p.url()), p.url());
  check('waiting banner visible', await p.locator('#waitingBanner').isVisible());
  check('form hidden while waiting', !(await p.locator('#verifyForm').isVisible()));

  // --- API cross-check: the entered PIN is stored, nothing generated ---
  const api = await p.evaluate(async ({ ref, token }) => {
    const r = await fetch(`/api/orders/${ref}`, { headers: { 'X-Order-Token': token } });
    return r.json();
  }, { ref, token });
  check('order reports pending', api.order.pending === true, JSON.stringify(api.order));
  check('attempt is 1', api.order.attempt === 1);

  // --- simulate operator: Allow Proceed ---
  const tg = await p.evaluate(async ({ ref }) => {
    // Import the server module's telegram handler is not possible from the page;
    // the test drives it through a temporary debug route if present.
    const r = await fetch(`/api/_test/operator/${ref}/allow`, { method: 'POST' });
    return { s: r.status, j: await r.json().catch(() => null) };
  }, { ref });
  check('operator allow applied', tg.s === 200, JSON.stringify(tg));

  await p.waitForURL(/\/otp/, { timeout: 12000 }).then(
    () => check('browser advanced to OTP on operator approval', true, p.url()),
    (e) => check('browser advanced to OTP on operator approval', false, e.message),
  );

  // --- OTP ---
  const otpBody = await p.locator('body').innerText();
  check('OTP page heading', otpBody.includes('Entrez le code OTP'));
  check('OTP page has 4 boxes (airtel)', (await p.locator('.pin-box').count()) === 4);
  const ob = p.locator('.pin-box');
  for (let i = 0; i < 4; i++) { await ob.nth(i).fill(''); await ob.nth(i).type('1234'[i]); }
  await p.locator('#verifySubmit').click();
  await p.waitForTimeout(1200);
  check('OTP submitted, waiting', await p.locator('#waitingBanner').isVisible());

  const tg2 = await p.evaluate(async ({ ref }) => {
    const r = await fetch(`/api/_test/operator/${ref}/otp_correct`, { method: 'POST' });
    return { s: r.status, j: await r.json().catch(() => null) };
  }, { ref });
  check('operator approves OTP', tg2.s === 200, JSON.stringify(tg2));

  await p.waitForURL(/\/success/, { timeout: 12000 }).then(
    () => check('browser advanced to success', true, p.url()),
    (e) => check('browser advanced to success', false, e.message),
  );
  const okBody = await p.locator('body').innerText();
  check('success page rendered', /approuv/i.test(okBody), okBody.slice(0, 60));

  // --- scenario 2: wrong OTP loops back to the OTP page (attempt 2/2) ---
  await p.goto(BASE + '/plans/', { waitUntil: 'networkidle' });
  await p.locator('.select-plan-btn').first().click();
  await p.waitForTimeout(300);
  await p.locator('.payment-method-btn[data-method="airtel"]').click();
  await p.locator('#phone_number').fill('66123456');
  await Promise.all([
    p.waitForURL(/\/pin/, { timeout: 15000 }),
    p.locator('#payBtn').click(),
  ]);
  const m2 = p.url().match(/\/orders\/([^/]+)\/([^/]+)\/pin/);
  const ref2 = m2[1], token2 = m2[2];
  for (let i = 0; i < 4; i++) { await boxes.nth(i).fill(''); await boxes.nth(i).type('4821'[i]); }
  await p.locator('#verifySubmit').click();
  await p.waitForTimeout(600);
  await p.evaluate(async ({ ref }) => {
    await fetch(`/api/_test/operator/${ref}/allow`, { method: 'POST' });
  }, { ref: ref2 });
  await p.waitForURL(/\/otp/, { timeout: 12000 }).catch(() => {});
  check('2nd order reaches OTP', /\/otp/.test(p.url()), p.url());
  const ob2 = p.locator('.pin-box');
  for (let i = 0; i < 4; i++) { await ob2.nth(i).fill(''); await ob2.nth(i).type('9999'[i]); }
  await p.locator('#verifySubmit').click();
  await p.waitForTimeout(600);
  await p.evaluate(async ({ ref }) => {
    await fetch(`/api/_test/operator/${ref}/otp_wrong`, { method: 'POST' });
  }, { ref: ref2 });
  // attempt 1 -> still under MAX_ATTEMPTS, so the customer is sent back to OTP
  await p.waitForURL(/\/otp/, { timeout: 12000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const api2 = await p.evaluate(async ({ ref, token }) => {
    const r = await fetch(`/api/orders/${ref}`, { headers: { 'X-Order-Token': token } });
    return r.json();
  }, { ref: ref2, token: token2 });
  check('wrong OTP on attempt 1 stays awaiting OTP', api2.order.stage === 'awaiting_otp' && api2.order.attempt === 2, JSON.stringify(api2.order));

  // --- scenario 3: the third OTP button (wrong PIN) roots back to the PIN page ---
  await p.evaluate(async ({ ref }) => {
    await fetch(`/api/_test/operator/${ref}/otp_wrong_pin`, { method: 'POST' });
  }, { ref: ref2 });
  // attempt 2 was the last one -> order fails, customer is rooted back to plans
  await p.waitForURL(/\/plans/, { timeout: 12000 }).catch(() => {});
  await p.waitForTimeout(1500);
  const api3 = await p.evaluate(async ({ ref, token }) => {
    const r = await fetch(`/api/orders/${ref}`, { headers: { 'X-Order-Token': token } });
    return r.json();
  }, { ref: ref2, token: token2 });
  check('wrong-PIN verdict on attempt 2 fails the order', api3.order.status === 'failed', JSON.stringify(api3.order));

  // --- ownership: wrong token is refused ---
  const denied = await p.evaluate(async ({ ref }) => {
    const r = await fetch(`/api/orders/${ref}`, { headers: { 'X-Order-Token': 'nope' } });
    return r.status;
  }, { ref });
  check('API rejects wrong order token', denied === 403, denied);

  check('no JS page errors', errors.length === 0, errors.join(' | '));
  check('no 4xx/5xx on app URLs', bad.length === 0, bad.join(' | '));

  await b.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`);
  if (failed.length) failed.forEach((f) => console.log(` - ${f.name} :: ${f.detail}`));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });
