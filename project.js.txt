import { getAuthenticatedUser, db } from "./_auth.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n) => Math.round(n * 1e6) / 1e6;
const createId = () => "pr_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const MAX_QTY = 20;
const pct = (v, d) => (v === undefined || v === null ? d : Math.min(100, Math.max(0, num(v))));

// Per-user lock: ek time par ek hi purchase (double click / parallel request block)
async function acquireLock(database, key, ttlMs = 20000) {
  const ref = database.ref(`locks/${key}`);
  const now = Date.now();
  let got = false;
  const r = await ref.transaction((cur) => {
    got = false;
    if (cur && now - num(cur) < ttlMs) return; // lock abhi active hai -> abort
    got = true;
    return now;
  });
  return r.committed && got ? ref : null;
}
const releaseLock = async (ref) => { try { await ref.remove(); } catch (_) {} };

// Atomic wallet debit: balance kam ho to false
async function debitWallet(database, uid, price) {
  let ok = false;
  await database.ref(`wallets/${uid}`).transaction((w) => {
    ok = false;
    const cur = w || {};
    const bal = num(cur.balance);
    if (bal < price) return w === null ? { balance: 0 } : undefined;
    ok = true;
    return { ...cur, balance: round(bal - price), totalInvested: round(num(cur.totalInvested) + price) };
  });
  return ok;
}

// Atomic wallet credit
async function creditWallet(database, uid, amount, extraField) {
  await database.ref(`wallets/${uid}`).transaction((w) => {
    const cur = w || {};
    const next = { ...cur, balance: round(num(cur.balance) + amount) };
    if (extraField) next[extraField] = round(num(cur[extraField]) + amount);
    return next;
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    try {
      const auth = await getAuthenticatedUser(req);
      const database = db();
      const [productsSnap, myProjectsSnap, supportSnap, referralSnap, paymentsSnap] = await Promise.all([
        database.ref("products").get(),
        auth ? database.ref(`user_projects/${auth.uid}`).get() : Promise.resolve({ exists: () => false }),
        database.ref("adminSettings/support").get(),
        database.ref("adminSettings/referral").get(),
        database.ref("adminSettings/payments").get(),
      ]);
      const rf = referralSnap.exists() ? referralSnap.val() : {};
      const referral = { level1: pct(rf.commissionPercent, 25), level2: pct(rf.level2Percent, 3), level3: pct(rf.level3Percent, 1) };
      const sup = supportSnap.exists() ? supportSnap.val() : {};
      const support = {
        telegramUsername: /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(String(sup.telegramUsername || "")) ? String(sup.telegramUsername) : "",
        channelLink: /^https:\/\/(t|telegram)\.me\//i.test(String(sup.channelLink || "")) ? String(sup.channelLink) : "",
      };
      // Popups me dikhane ke liye admin ki limits aur withdrawal charge
      const pm = paymentsSnap.exists() ? paymentsSnap.val() : {};
      const payments = {
        minDeposit: num(pm.minDeposit) > 0 ? num(pm.minDeposit) : 1,
        maxDeposit: num(pm.maxDeposit) > 0 ? num(pm.maxDeposit) : 100000,
        minWithdrawal: num(pm.minWithdrawal) > 0 ? num(pm.minWithdrawal) : 1,
        maxWithdrawal: num(pm.maxWithdrawal) > 0 ? num(pm.maxWithdrawal) : 100000,
        withdrawalChargePercent: Math.min(99.99, Math.max(0, num(pm.withdrawalChargePercent))),
      };
      const products = [];
      if (productsSnap.exists()) {
        productsSnap.forEach((child) => {
          const p = child.val();
          const saleOver = p.projectType === "vip" && num(p.saleEndsAt) > 0 && Date.now() > num(p.saleEndsAt);
          if (p.active !== false && p.deleted !== true && !saleOver) products.push(p);
        });
      }
      const myProjects = myProjectsSnap.exists() ? Object.values(myProjectsSnap.val()) : [];
      return res.status(200).json({ success: true, products, myProjects, support, referral, payments, serverTime: Date.now() });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to load projects" });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let lockRef = null;
  try {
    const auth = await getAuthenticatedUser(req);
    if (!auth || !auth.uid) return res.status(401).json({ success: false, message: "Please log in first" });

    const productId = String((req.body || {}).productId || "").trim();
    if (!productId) return res.status(400).json({ success: false, message: "Product ID required" });

    const quantity = Math.floor(num((req.body || {}).quantity)) || 1;
    if (quantity < 1 || quantity > MAX_QTY) return res.status(400).json({ success: false, message: "Invalid quantity" });

    const database = db();
    const uid = auth.uid;

    lockRef = await acquireLock(database, `purchase_${uid}`);
    if (!lockRef) return res.status(429).json({ success: false, message: "Another purchase is in progress. Please wait." });

    const [productSnap, myProjectsSnap, settingsSnap] = await Promise.all([
      database.ref(`products/${productId}`).get(),
      database.ref(`user_projects/${uid}`).get(),
      database.ref("adminSettings/referral").get(),
    ]);

    if (!productSnap.exists()) return res.status(404).json({ success: false, message: "Project not found" });
    const product = productSnap.val();
    if (product.active === false || product.deleted === true) {
      return res.status(400).json({ success: false, message: "Project is currently unavailable" });
    }

    if (product.projectType === "vip" && num(product.saleEndsAt) > 0 && Date.now() > num(product.saleEndsAt)) {
      return res.status(400).json({ success: false, message: "This VIP sale has ended" });
    }

    const price = num(product.price);
    const dailyProfit = num(product.dailyProfit);
    const validityDays = Math.floor(num(product.validityDays));
    const limit = Math.floor(num(product.purchaseLimit)) || 1;
    if (price <= 0 || validityDays < 1) return res.status(400).json({ success: false, message: "Invalid project configuration" });

    let activeCount = 0;
    if (myProjectsSnap.exists()) {
      myProjectsSnap.forEach((child) => {
        const p = child.val();
        if (p.productId === productId && num(p.daysRemaining) > 0) activeCount++;
      });
    }
    const remaining = limit - activeCount;
    if (remaining <= 0) {
      return res.status(400).json({ success: false, message: `Limit reached. You can only have ${limit} active at a time.` });
    }
    if (quantity > remaining) {
      return res.status(400).json({ success: false, message: `You can buy only ${remaining} more of this project (limit ${limit}, ${activeCount} active).` });
    }

    const totalPrice = round(price * quantity);

    // 1) Atomic paisa katna (poori quantity ka ek saath)
    const debited = await debitWallet(database, uid, totalPrice);
    if (!debited) return res.status(400).json({ success: false, message: "Insufficient USDT balance" });

    // 2) Projects + history ek hi write me (ya to sab ban jaayein ya kuch nahi); fail ho to refund
    const purchaseId = createId(); // history/commission ke liye batch id
    const timestamp = Date.now();
    try {
      const writes = {
        [`depositOrders/${purchaseId}`]: {
          orderId: purchaseId, uid, type: "purchase", projectName: String(product.name || ""), quantity,
          amount: -totalPrice, currency: "USDT", status: "completed", createdAt: timestamp,
        },
      };
      for (let i = 0; i < quantity; i++) {
        const projectId = createId();
        writes[`user_projects/${uid}/${projectId}`] = {
          id: projectId, batchId: purchaseId, productId, name: product.name,
          projectType: product.projectType === "vip" ? "vip" : "normal", price, dailyProfit,
          totalDays: validityDays, daysRemaining: validityDays, purchasedAt: timestamp,
        };
      }
      await database.ref().update(writes);
    } catch (err) {
      console.error("Purchase write failed, refunding:", err);
      await database.ref(`wallets/${uid}`).transaction((w) => {
        const cur = w || {};
        return { ...cur, balance: round(num(cur.balance) + totalPrice), totalInvested: round(Math.max(0, num(cur.totalInvested) - totalPrice)) };
      });
      return res.status(500).json({ success: false, message: "Transaction failed" });
    }

    // 2b) Salary programme: referral ki PEHLI purchase par uske referrer ki "successful directs" me ginti
    // (jinke paas pehle se projects the, wo ginti me nahi aate; ek referral sirf ek baar ginta hai)
    try {
      if (!myProjectsSnap.exists()) {
        const attr = await database.ref(`referralAttributions/${uid}`).get();
        const referrerUid = attr.exists() ? attr.val().referrerUid : null;
        if (referrerUid && referrerUid !== uid) {
          await database.ref(`salaryReferrals/${referrerUid}/${uid}`).transaction((cur) => (cur === null ? Date.now() : undefined));
        }
      }
    } catch (err) {
      console.error("Salary referral count error:", err);
    }

    // 3) Referral commission: har level ko ek purchase par sirf ek baar
    try {
      const ref = settingsSnap.exists() ? settingsSnap.val() : {};
      const percents = [pct(ref.commissionPercent, 25), pct(ref.level2Percent, 3), pct(ref.level3Percent, 1)];
      const visited = new Set([uid]);
      let currentUid = uid;

      for (let i = 0; i < 3; i++) {
        const attrSnap = await database.ref(`referralAttributions/${currentUid}`).get();
        if (!attrSnap.exists()) break;
        const uplineUid = attrSnap.val().referrerUid;
        if (!uplineUid || visited.has(uplineUid)) break; // self-referral / loop block
        visited.add(uplineUid);
        currentUid = uplineUid;

        if (percents[i] <= 0) continue;
        const commAmount = round((totalPrice * percents[i]) / 100);
        if (commAmount <= 0) continue;

        const commLogId = `comm_${purchaseId}_L${i + 1}`;
        let claimed = false;
        await database.ref(`depositOrders/${commLogId}`).transaction((cur) => {
          claimed = false;
          if (cur !== null) return; // already paid
          claimed = true;
          return { orderId: commLogId, uid: uplineUid, type: "commission", amount: commAmount, currency: "USDT", status: "completed", fromUid: uid, level: i + 1, createdAt: timestamp };
        });
        if (claimed) await creditWallet(database, uplineUid, commAmount, "totalCommission");
      }
    } catch (err) {
      // Purchase ho chuka hai; commission error ko log karo, user ko fail mat dikhao
      console.error("Commission error for", purchaseId, err);
      await database.ref(`failedCommissions/${purchaseId}`).set({ uid, purchaseId, price: totalPrice, at: Date.now() }).catch(() => {});
    }

    return res.status(200).json({ success: true, quantity, message: quantity > 1 ? `${quantity} projects purchased successfully!` : "Project purchased successfully!" });
  } catch (error) {
    console.error("Purchase error:", error);
    return res.status(500).json({ success: false, message: "Transaction failed" });
  } finally {
    if (lockRef) await releaseLock(lockRef);
  }
}
