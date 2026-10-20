import crypto, { randomUUID } from "node:crypto";
import { getAuthenticatedUser, db } from "./_auth.js";

const round = (n) => Math.round(n * 1e6) / 1e6;
const round2 = (n) => Math.round(n * 100) / 100;

// User ke chip ka naam -> OxaPay ko jaane wala network naam
const NETWORKS = { BEP20: "BEP20", POLYGON: "Polygon", TRC20: "TRC20" };

// BEP20 aur Polygon ke address 0x se shuru hote hain, TRC20 ka T se
const isEvmAddress = (address) => /^0x[a-fA-F0-9]{40}$/.test(address);
const isTronAddress = (address) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);

// Ek hi address ka key sabhi networks par same rahega
function addressKey(address) {
  const normalized = address.startsWith("0x") ? address.toLowerCase() : address;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// Ek user ki do withdrawal requests ek saath na chalein (double tap / parallel request)
async function acquireLock(database, key, ttlMs = 20000) {
  const ref = database.ref(`locks/${key}`);
  const now = Date.now();
  let got = false;
  const r = await ref.transaction((cur) => {
    got = false;
    if (cur && now - Number(cur) < ttlMs) return;
    got = true;
    return now;
  });
  return r.committed && got ? ref : null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  let userLock = null;

  try {
    const auth = await getAuthenticatedUser(req);

    if (!auth || !auth.uid) {
      return res.status(401).json({ success: false, message: "Please log in first" });
    }

    const database = db();

    userLock = await acquireLock(database, `withdraw_${auth.uid}`);
    if (!userLock) {
      return res.status(429).json({ success: false, message: "Another withdrawal is in progress. Please wait a moment." });
    }

    // Load admin payment settings
    const settingsSnap = await database.ref("adminSettings/payments").get();

    const settings = settingsSnap.exists()
      ? settingsSnap.val()
      : { withdrawalEnabled: true, minWithdrawal: 1, maxWithdrawal: 100000, withdrawalChargePercent: 0 };

    // Withdrawal ON/OFF
    if (settings.withdrawalEnabled !== true) {
      return res.status(403).json({ success: false, message: "Withdrawals are currently disabled" });
    }

    const minWithdrawal = Number(settings.minWithdrawal);
    const maxWithdrawal = Number(settings.maxWithdrawal);

    if (
      !Number.isFinite(minWithdrawal) ||
      !Number.isFinite(maxWithdrawal) ||
      minWithdrawal <= 0 ||
      maxWithdrawal < minWithdrawal
    ) {
      return res.status(500).json({ success: false, message: "Withdrawal settings are invalid" });
    }

    // Admin-controlled withdrawal charge (%), ek hi sab networks ke liye
    const chargePercent = Math.min(99.99, Math.max(0, Number(settings.withdrawalChargePercent) || 0));

    const sandbox = process.env.OXAPAY_SANDBOX === "true";
    const payoutKey = process.env.OXAPAY_PAYOUT_API_KEY;
    const baseUrl = process.env.SITE_URL || "https://noir-vip.vercel.app";

    if (!sandbox && !payoutKey) {
      return res.status(500).json({ success: false, message: "Payout configuration is missing" });
    }

    const requested = Number(req.body && req.body.amount);
    const address = String((req.body && req.body.address) || "").trim();

    if (!Number.isFinite(requested)) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal amount" });
    }

    const amount = round2(requested);

    // Admin-controlled minimum / maximum
    if (amount < minWithdrawal || amount > maxWithdrawal) {
      return res.status(400).json({
        success: false,
        message: `Withdrawal amount must be between ${minWithdrawal} and ${maxWithdrawal} USDT`,
      });
    }

    // Charge: balance se poori amount kategi, user ko amount minus charge milega
    const fee = round2((amount * chargePercent) / 100);
    const netAmount = round2(amount - fee);

    if (netAmount <= 0) {
      return res.status(400).json({ success: false, message: "Amount is too low after the withdrawal charge" });
    }

    // Admin option: withdrawal se pehle kam se kam 1 project kharidna zaroori
    if (settings.requireProjectForWithdrawal === true) {
      const projSnap = await database.ref(`user_projects/${auth.uid}`).limitToFirst(1).get();
      if (!projSnap.exists()) {
        return res.status(403).json({
          success: false,
          code: "project_required",
          message: "Buy at least 1 project to withdraw.",
        });
      }
    }

    // Network: user chip se chunta hai (BEP20 / POLYGON / TRC20). Na bheje to BEP20.
    const wantedNetwork = String((req.body && req.body.network) || "BEP20").trim().toUpperCase();
    const network = NETWORKS[wantedNetwork];

    if (!network) {
      return res.status(400).json({ success: false, message: "Choose a valid network (BEP20, Polygon or TRC20)" });
    }

    const addressOk = network === "TRC20" ? isTronAddress(address) : isEvmAddress(address);
    if (!addressOk) {
      return res.status(400).json({
        success: false,
        message: network === "TRC20"
          ? "Wrong address. A TRC20 address starts with T and has 34 characters."
          : "Wrong address. A " + network + " address starts with 0x and has 42 characters.",
      });
    }

    // Balance pehle dekho, taaki bina paise wala user kisi ka address "lock" na kar sake
    const balSnap = await database.ref(`wallets/${auth.uid}/balance`).get();
    if (!balSnap.exists() || Number(balSnap.val()) < amount) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // 1. One address can belong to only one account.
    const lockRef = database.ref("addressLocks/" + addressKey(address));

    const lock = await lockRef.transaction((current) => {
      if (current === null) {
        return { uid: auth.uid, network, at: Date.now() };
      }
      if (current.uid !== auth.uid) {
        return;
      }
      return current;
    });

    if (!lock.committed) {
      return res.status(409).json({ success: false, message: "This address is already linked to another account" });
    }

    // 2. Save withdrawal request (amount = poori rakam jo balance se kati)
    const withdrawalId = "WDR_" + randomUUID();
    const requestRef = database.ref("withdrawalRequests/" + withdrawalId);

    await requestRef.set({
      withdrawalId,
      uid: auth.uid,
      amount,
      chargePercent,
      fee,
      netAmount,
      currency: "USDT",
      address,
      network,
      sandbox,
      status: "creating",
      createdAt: Date.now(),
    });

    // 3. Deduct balance atomically (poori amount)
    const walletRef = database.ref("wallets/" + auth.uid);

    const debit = await walletRef.transaction((current) => {
      if (current === null) return current;

      const balance = Number(current.balance || 0);
      const debited = current.debited || {};

      if (debited[withdrawalId]) return;
      if (balance < amount) return;

      current.balance = round(balance - amount);
      current.debited = { ...debited, [withdrawalId]: { amount, at: Date.now() } };
      current.updatedAt = Date.now();

      return current;
    });

    const after = debit.snapshot.val();

    if (!debit.committed || !after || !after.debited || !after.debited[withdrawalId]) {
      await requestRef.update({ status: "rejected", reason: "insufficient_balance", updatedAt: Date.now() });
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // 4a. Sandbox
    if (sandbox) {
      await requestRef.update({ status: "sandbox_simulated", updatedAt: Date.now() });

      return res.status(200).json({
        success: true,
        withdrawalId,
        amount,
        fee,
        netAmount,
        currency: "USDT",
        status: "sandbox_simulated",
      });
    }

    await requestRef.update({ status: "processing", updatedAt: Date.now() });

    // 4b. Live OxaPay payout (user ko amount minus charge bheja jaata hai)
    let response;
    let result;

    try {
      response = await fetch("https://api.oxapay.com/v1/payout", {
        method: "POST",
        headers: { payout_api_key: payoutKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          currency: "USDT",
          amount: netAmount,
          network,
          description: withdrawalId,
          callback_url: baseUrl + "/api/oxapay-webhook",
        }),
      });

      result = await response.json().catch(() => ({}));
    } catch (networkError) {
      console.error("OxaPay payout network error:", networkError.message);

      await requestRef.update({ status: "review_required", reason: "payout_unknown", updatedAt: Date.now() });

      return res.status(202).json({ success: true, withdrawalId, status: "review_required" });
    }

    // Clear payout failure -> refund once (poori amount wapas)
    if (!response.ok || !result.data || !result.data.track_id) {
      console.error(
        "OxaPay payout failed: HTTP " + response.status + " | " + JSON.stringify(result.error || result.message || result)
      );

      await walletRef.transaction((current) => {
        if (current === null) return current;

        const refunded = current.refunded || {};

        if (refunded[withdrawalId]) return;
        if (!(current.debited || {})[withdrawalId]) return;

        current.balance = round(Number(current.balance || 0) + amount);
        current.refunded = { ...refunded, [withdrawalId]: { amount, at: Date.now() } };
        current.updatedAt = Date.now();

        return current;
      });

      await requestRef.update({
        status: "failed",
        reason: String((result.error && result.error.message) || result.message || "payout_failed"),
        updatedAt: Date.now(),
      });

      return res.status(502).json({ success: false, message: "Payout failed, balance returned" });
    }

    // OxaPay accepted payout
    const trackId = String(result.data.track_id);

    await database.ref("payoutTracks/" + trackId).set(withdrawalId);

    await requestRef.update({
      status: "processing",
      trackId,
      payoutStatus: String(result.data.status || ""),
      updatedAt: Date.now(),
    });

    return res.status(200).json({
      success: true,
      withdrawalId,
      amount,
      fee,
      netAmount,
      currency: "USDT",
      status: "processing",
    });
  } catch (error) {
    console.error("NOIR withdraw error:", error.message);

    return res.status(500).json({ success: false, message: "Unable to process withdrawal" });
  } finally {
    if (userLock) {
      try { await userLock.remove(); } catch (_) {}
    }
  }
}
