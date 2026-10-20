import { db } from "../_auth.js";

const DEFAULT_SETTINGS = {
  payments: {
    depositEnabled: true, minDeposit: 1, maxDeposit: 100000,
    withdrawalEnabled: true, minWithdrawal: 1, maxWithdrawal: 100000,
    withdrawalChargePercent: 0,
  },
  referral: { commissionPercent: 25, level2Percent: 3, level3Percent: 1 },
};

function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAdmin(req) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return false;
  return safeEqual(req.headers["x-admin-username"], username) && safeEqual(req.headers["x-admin-password"], password);
}

function numberValue(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.round(n * 1000000) / 1000000;
}

function cleanProduct(product, existing = {}) {
  const projectType =
    product.projectType === "vip" || product.projectType === "normal"
      ? product.projectType
      : existing.projectType === "vip" ? "vip" : "normal";
  const deadlineDays = projectType === "vip"
    ? Math.floor(numberValue(product.saleDeadlineDays, existing.saleDeadlineDays ?? 0, 0))
    : 0;
  // Deadline wahi rahe to purani end-date, badli ya naya VIP ho to ab se ginti shuru
  const sameDeadline =
    existing.projectType === "vip" && Number(existing.saleEndsAt) > 0 &&
    Number(existing.saleDeadlineDays) === deadlineDays;
  const saleEndsAt = deadlineDays > 0
    ? (sameDeadline ? Number(existing.saleEndsAt) : Date.now() + deadlineDays * 86400000)
    : null;

  return {
    projectType,
    saleDeadlineDays: deadlineDays > 0 ? deadlineDays : null,
    saleEndsAt,
    name: String(product.name ?? existing.name ?? "").trim(),
    description: String(product.description ?? existing.description ?? "").trim(),
    price: numberValue(product.price, existing.price ?? 0, 0.01),
    dailyProfit: numberValue(product.dailyProfit, existing.dailyProfit ?? 0, 0),
    validityDays: Math.floor(numberValue(product.validityDays, existing.validityDays ?? 1, 1)),
    purchaseLimit: Math.floor(numberValue(product.purchaseLimit, existing.purchaseLimit ?? 1, 1)),
    active: typeof product.active === "boolean" ? product.active : existing.active !== false,
    updatedAt: Date.now(),
  };
}

function validateProduct(product) {
  if (!product.name) return "Product name is required";
  if (product.price <= 0) return "Product price must be greater than 0";
  if (product.dailyProfit < 0) return "Daily profit cannot be negative";
  return null;
}

const createProductId = () =>
  ("product_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).toUpperCase();

const fail = (res, code, message) => res.status(code).json({ success: false, message });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");

  try {
    if (req.method === "GET") {
      if (!isAdmin(req)) return fail(res, 403, "Admin access required");
      const database = db();
      const [settingsSnap, productsSnap] = await Promise.all([
        database.ref("adminSettings").get(),
        database.ref("products").get(),
      ]);
      const settings = settingsSnap.exists() ? settingsSnap.val() : DEFAULT_SETTINGS;
      const all = productsSnap.exists() ? productsSnap.val() : {};
      const products = {};
      Object.keys(all).forEach((id) => { if (all[id] && !all[id].deleted) products[id] = all[id]; }); // soft-deleted hide
      return res.status(200).json({ success: true, settings, products });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return fail(res, 405, "Method not allowed");
    }
    if (!isAdmin(req)) return fail(res, 403, "Admin access required");

    const database = db();
    const body = req.body || {};
    const action = String(body.action || "").trim();

    if (action === "stats") {
      const now = Date.now();
      const DAY = 86400000;
      const IST = 330 * 60000;
      const todayStart = Math.floor((now + IST) / DAY) * DAY - IST; // India ka aaj
      const r2 = (n) => Math.round(n * 100) / 100;

      const [depSnap, wdrSnap, salCfgSnap, salRefSnap, walletsSnap] = await Promise.all([
        database.ref("depositOrders").get(),
        database.ref("withdrawalRequests").get(),
        database.ref("adminSettings/salary").get(),
        database.ref("salaryReferrals").get(),
        database.ref("wallets").get(),
      ]);

      let totalUserBalance = 0, walletCount = 0;
      walletsSnap.forEach((child) => {
        const w = child.val() || {};
        totalUserBalance += Number(w.balance) || 0;
        walletCount += 1;
      });

      let totalDeposit = 0, todayDeposit = 0, todayInvestment = 0;
      depSnap.forEach((child) => {
        const o = child.val() || {};
        const amt = Number(o.amount) || 0;
        if (!o.type || o.type === "deposit") {
          if (o.status === "paid") {
            totalDeposit += amt;
            if ((Number(o.paidAt) || Number(o.createdAt) || 0) >= todayStart) todayDeposit += amt;
          }
        } else if (o.type === "purchase") {
          if ((Number(o.createdAt) || 0) >= todayStart) todayInvestment += -amt;
        }
      });

      const PENDING = ["processing", "confirming", "review_required"];
      let totalWithdrawal = 0, pendingWithdrawal = 0, todayWithdrawal = 0;
      wdrSnap.forEach((child) => {
        const w = child.val() || {};
        const amt = Number(w.amount) || 0;
        const done = w.status === "completed";
        const pend = PENDING.includes(w.status);
        if (done) totalWithdrawal += amt;
        if (pend) pendingWithdrawal += amt;
        if ((done || pend) && (Number(w.createdAt) || 0) >= todayStart) todayWithdrawal += amt;
      });

      // Salary: is mahine ki payday par sabko kul kitna jaayega
      const cfg = salCfgSnap.exists() ? salCfgSnap.val() : { enabled: true, payDay: 20, tiers: [{ referrals: 30, amount: 90 }] };
      const tiers = (Array.isArray(cfg.tiers) ? cfg.tiers : [])
        .map((t) => ({ referrals: Math.floor(Number(t && t.referrals)) || 0, amount: Number(t && t.amount) || 0 }))
        .filter((t) => t.referrals >= 1 && t.amount > 0)
        .sort((a, b) => a.referrals - b.referrals);
      let salaryTotal = 0, salaryUsers = 0;
      if (cfg.enabled !== false && salRefSnap.exists()) {
        Object.values(salRefSnap.val()).forEach((children) => {
          const count = Object.keys(children || {}).length;
          const reached = tiers.filter((t) => count >= t.referrals);
          if (reached.length) { salaryTotal += reached[reached.length - 1].amount; salaryUsers += 1; }
        });
      }

      return res.status(200).json({
        success: true,
        stats: {
          totalUserBalance: r2(totalUserBalance),
          walletCount,
          totalDeposit: r2(totalDeposit),
          totalWithdrawal: r2(totalWithdrawal),
          pendingWithdrawal: r2(pendingWithdrawal),
          todayDeposit: r2(todayDeposit),
          todayWithdrawal: r2(todayWithdrawal),
          todayInvestment: r2(todayInvestment),
          salary: { enabled: cfg.enabled !== false, payDay: Number(cfg.payDay) || 20, totalAmount: r2(salaryTotal), users: salaryUsers },
        },
      });
    }

    // Neeche ke 4 save actions ab sirf ek hi database write karte hain (pehle read + write do chakkar the),
    // aur sirf badla hua hissa wapas bhejte hain (patch), taaki admin panel turant update ho.
    const validNum = (v, min) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? Math.round(n * 1000000) / 1000000 : null;
    };

    if (action === "updatePayments") {
      const p = body.payments || {};
      const minDeposit = validNum(p.minDeposit, 0.01);
      const maxDeposit = validNum(p.maxDeposit, 0.01);
      const minWithdrawal = validNum(p.minWithdrawal, 0.01);
      const maxWithdrawal = validNum(p.maxWithdrawal, 0.01);

      if ([minDeposit, maxDeposit, minWithdrawal, maxWithdrawal].some((v) => v === null)) {
        return fail(res, 400, "Enter valid minimum and maximum amounts");
      }
      if (maxDeposit < minDeposit) return fail(res, 400, "Maximum deposit cannot be lower than minimum deposit");
      if (maxWithdrawal < minWithdrawal) return fail(res, 400, "Maximum withdrawal cannot be lower than minimum withdrawal");

      // Withdrawal charge (%): khali ho to 0, warna 0 se 99.99 ke beech
      const rawCharge = p.withdrawalChargePercent;
      const withdrawalChargePercent =
        rawCharge === undefined || rawCharge === null || rawCharge === "" ? 0 : validNum(rawCharge, 0);
      if (withdrawalChargePercent === null || withdrawalChargePercent >= 100) {
        return fail(res, 400, "Withdrawal charge must be between 0 and 99.99%");
      }

      const payments = {
        depositEnabled: typeof p.depositEnabled === "boolean" ? p.depositEnabled : true,
        minDeposit, maxDeposit,
        withdrawalEnabled: typeof p.withdrawalEnabled === "boolean" ? p.withdrawalEnabled : true,
        minWithdrawal, maxWithdrawal,
        withdrawalChargePercent,
        requireProjectForWithdrawal: typeof p.requireProjectForWithdrawal === "boolean" ? p.requireProjectForWithdrawal : false,
      };
      await database.ref("adminSettings").update({ payments, updatedAt: Date.now() });
      return res.status(200).json({ success: true, message: "Payment settings saved", patch: { payments } });
    }

    if (action === "updateReferral") {
      const l1 = validNum(body.commissionPercent, 0);
      const l2 = validNum(body.level2Percent, 0);
      const l3 = validNum(body.level3Percent, 0);
      if (l1 === null || l2 === null || l3 === null) return fail(res, 400, "Enter valid commission percentages");
      if (l1 > 100 || l2 > 100 || l3 > 100) return fail(res, 400, "Commission cannot exceed 100%");
      if (l1 + l2 + l3 > 100) return fail(res, 400, "Total commission cannot exceed 100%");

      const referral = { commissionPercent: l1, level2Percent: l2, level3Percent: l3 };
      await database.ref("adminSettings").update({ referral, updatedAt: Date.now() });
      return res.status(200).json({ success: true, message: "Referral settings saved", patch: { referral } });
    }

    if (action === "updateSalary") {
      const payDay = Math.floor(Number(body.payDay));
      if (!Number.isFinite(payDay) || payDay < 1 || payDay > 28) {
        return fail(res, 400, "Pay day must be between 1 and 28");
      }

      const rawTiers = Array.isArray(body.tiers) ? body.tiers : [];
      if (rawTiers.length > 20) return fail(res, 400, "Maximum 20 salary levels allowed");

      const seen = new Set();
      const tiers = [];
      for (const t of rawTiers) {
        const referrals = Math.floor(Number(t && t.referrals));
        const amount = Number(t && t.amount);
        if (!Number.isFinite(referrals) || referrals < 1 || referrals > 1000000) return fail(res, 400, "Each level needs a valid referral count");
        if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return fail(res, 400, "Each level needs a valid salary amount");
        if (seen.has(referrals)) return fail(res, 400, "Two levels have the same referral count: " + referrals);
        seen.add(referrals);
        tiers.push({ referrals, amount: Math.round(amount * 100) / 100 });
      }
      tiers.sort((a, b) => a.referrals - b.referrals);

      const salary = { enabled: body.enabled === true, payDay, tiers };
      await database.ref("adminSettings").update({ salary, updatedAt: Date.now() });
      return res.status(200).json({ success: true, message: "Salary settings saved", patch: { salary } });
    }

    if (action === "updateSupport") {
      let telegramUsername = String(body.telegramUsername || "").trim()
        .replace(/^https?:\/\/(t|telegram)\.me\//i, "").replace(/^@/, "");
      if (telegramUsername && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegramUsername)) {
        return fail(res, 400, "Telegram username must be 5-32 characters: letters, numbers or underscore");
      }

      const channelLink = String(body.channelLink || "").trim();
      if (channelLink && !/^https:\/\/(t|telegram)\.me\/[A-Za-z0-9_+\-\/]{3,100}$/i.test(channelLink)) {
        return fail(res, 400, "Channel link must look like https://t.me/your_channel");
      }

      const support = { telegramUsername, channelLink };
      await database.ref("adminSettings").update({ support, updatedAt: Date.now() });
      return res.status(200).json({ success: true, message: "Support settings saved", patch: { support } });
    }

    if (action === "addProduct") {
      const product = cleanProduct(body.product || {});
      const err = validateProduct(product);
      if (err) return fail(res, 400, err);
      const productId = createProductId();
      await database.ref(`products/${productId}`).set({ productId, ...product, createdAt: Date.now() });
      return res.status(200).json({ success: true, message: "Product added", productId, product });
    }

    if (action === "updateProduct") {
      const productId = String(body.productId || "").trim();
      if (!productId) return fail(res, 400, "Product ID is required");
      const productRef = database.ref(`products/${productId}`);
      const snap = await productRef.get();
      if (!snap.exists() || snap.val().deleted) return fail(res, 404, "Product not found");
      const product = cleanProduct(body.product || {}, snap.val());
      const err = validateProduct(product);
      if (err) return fail(res, 400, err);
      await productRef.update(product);
      return res.status(200).json({ success: true, message: "Product updated", productId, product });
    }

    // SOFT DELETE: product hide hota hai, par user_projects (users ki purchases) bilkul touch nahi hoti
    if (action === "deleteProduct") {
      const productId = String(body.productId || "").trim();
      if (!productId) return fail(res, 400, "Product ID is required");
      const productRef = database.ref(`products/${productId}`);
      const snap = await productRef.get();
      if (!snap.exists()) return fail(res, 404, "Product not found");
      await productRef.update({ active: false, deleted: true, deletedAt: Date.now() });
      return res.status(200).json({ success: true, message: "Product deleted" });
    }

    return fail(res, 400, "Unknown admin action");
  } catch (error) {
    console.error("NOIR admin settings error:", error.code || error.message || "unknown");
    return fail(res, 500, "Unable to process admin request");
  }
}
