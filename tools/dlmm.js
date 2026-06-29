import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { fetchChartIndicatorsForMint, confirmIndicatorPreset } from "./chart-indicators.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { recordPositionEntry, recordPositionExit } from "../position-memory.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { normalizeMint, swapToken } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { getAndClearStagedSignals } from "../signal-tracker.js";
import { computePositions, fetchDlmmPnlForPool } from "./pnl.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;
let _Zap = null;
let _getJupiterQuote = null;
let _DlmmDirectSwapQuoteRoute = null;
let _DlmmSwapType = null;
let _getTokenProgramFromMint = null;
let _getOrCreateATAInstruction = null;
let _getTokenAccountBalance = null;
let _getLbPairState = null;
let _getDlmmRemainingAccounts = null;
let _createDlmmSwapPayload = null;
let _unwrapSOLInstruction = null;
let _DLMM_PROGRAM_ID = null;
let _AMOUNT_IN_DLMM_OFFSET = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
  };
}

async function getZapSDK() {
  if (!_Zap || !_getJupiterQuote || !_DlmmDirectSwapQuoteRoute || !_DlmmSwapType || !_getTokenProgramFromMint || !_getOrCreateATAInstruction || !_getTokenAccountBalance || !_getLbPairState || !_getDlmmRemainingAccounts || !_createDlmmSwapPayload || !_unwrapSOLInstruction || !_DLMM_PROGRAM_ID || _AMOUNT_IN_DLMM_OFFSET == null) {
    const mod = await import("@meteora-ag/zap-sdk");
    _Zap = mod.Zap;
    _getJupiterQuote = mod.getJupiterQuote;
    _DlmmDirectSwapQuoteRoute = mod.DlmmDirectSwapQuoteRoute;
    _DlmmSwapType = mod.DlmmSwapType;
    _getTokenProgramFromMint = mod.getTokenProgramFromMint;
    _getOrCreateATAInstruction = mod.getOrCreateATAInstruction;
    _getTokenAccountBalance = mod.getTokenAccountBalance;
    _getLbPairState = mod.getLbPairState;
    _getDlmmRemainingAccounts = mod.getDlmmRemainingAccounts;
    _createDlmmSwapPayload = mod.createDlmmSwapPayload;
    _unwrapSOLInstruction = mod.unwrapSOLInstruction;
    _DLMM_PROGRAM_ID = mod.DLMM_PROGRAM_ID;
    _AMOUNT_IN_DLMM_OFFSET = mod.AMOUNT_IN_DLMM_OFFSET;
  }
  return {
    Zap: _Zap,
    getJupiterQuote: _getJupiterQuote,
    DlmmDirectSwapQuoteRoute: _DlmmDirectSwapQuoteRoute,
    DlmmSwapType: _DlmmSwapType,
    getTokenProgramFromMint: _getTokenProgramFromMint,
    getOrCreateATAInstruction: _getOrCreateATAInstruction,
    getTokenAccountBalance: _getTokenAccountBalance,
    getLbPairState: _getLbPairState,
    getDlmmRemainingAccounts: _getDlmmRemainingAccounts,
    createDlmmSwapPayload: _createDlmmSwapPayload,
    unwrapSOLInstruction: _unwrapSOLInstruction,
    DLMM_PROGRAM_ID: _DLMM_PROGRAM_ID,
    AMOUNT_IN_DLMM_OFFSET: _AMOUNT_IN_DLMM_OFFSET,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, "confirmed");
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function getMeridianApiBase() {
  return String(config.api.url || "https://api.agentmeridian.xyz/api").replace(/\/+$/, "");
}

function getMeridianHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.api.publicApiKey) {
    headers["x-api-key"] = config.api.publicApiKey;
  }
  return headers;
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  return false;
}

const METEORA_ZAP_MAX_RANGE_BINS = 69;

function getLiquidityDivider({ downsidePct, upsidePct, activeBinsAbove, totalBins }) {
  const down = Math.max(0, Number(downsidePct ?? 0));
  const up = Math.max(0, Number(upsidePct ?? 0));
  if (up <= 0) return { xShare: 0, yShare: 1, source: "pct" };
  const pctTotal = down + up;
  if (pctTotal > 0) {
    const xShare = up / pctTotal;
    return { xShare, yShare: 1 - xShare, source: "pct" };
  }
  const binTotal = Math.max(1, Number(totalBins || 0));
  const xShare = Math.max(0, Number(activeBinsAbove || 0)) / binTotal;
  return { xShare, yShare: 1 - xShare, source: "bins" };
}

function capZapRangeToDivider({ activeBinsBelow, activeBinsAbove, downsidePct, upsidePct, totalBins }) {
  if (totalBins <= METEORA_ZAP_MAX_RANGE_BINS || activeBinsAbove <= 0) {
    return { activeBinsBelow, activeBinsAbove, totalBins, capped: false };
  }

  const divider = getLiquidityDivider({ downsidePct, upsidePct, activeBinsAbove, totalBins });
  let cappedAbove = Math.round(METEORA_ZAP_MAX_RANGE_BINS * divider.xShare);
  cappedAbove = Math.max(1, Math.min(METEORA_ZAP_MAX_RANGE_BINS - MIN_SAFE_BINS_BELOW, cappedAbove));
  const cappedBelow = METEORA_ZAP_MAX_RANGE_BINS - cappedAbove;
  return {
    activeBinsBelow: cappedBelow,
    activeBinsAbove: cappedAbove,
    totalBins: METEORA_ZAP_MAX_RANGE_BINS,
    capped: true,
    divider,
  };
}

function shouldUseMeteoraZapForDeploy({ activeBinsAbove, finalAmountX, isWideRange }) {
  return !!config.api.meteoraZapEnabled &&
    !shouldUseLpAgentRelayForDeploy() &&
    !isWideRange &&
    Number(activeBinsAbove) > 0 &&
    Number(finalAmountX || 0) === 0;
}


function shouldUseLpAgentRelayForClose() {
  return false; // relay zap-out consistently embeds SOL transfers that trip the safety check
}

async function meridianJson(pathname, options = {}) {
  const { retry, ...fetchOptions } = options;
  if (!retry) {
    return meridianJsonOnce(pathname, fetchOptions);
  }

  const maxElapsedMs = Number(retry.maxElapsedMs || 30_000);
  const maxAttempts = Number(retry.maxAttempts || 10);
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;

  while (Date.now() - startedAt < maxElapsedMs && attempt < maxAttempts) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(1, maxElapsedMs - elapsedMs);
    try {
      return await meridianJsonOnce(
        pathname,
        fetchOptions,
        Math.min(Number(retry.perAttemptTimeoutMs || 10_000), remainingMs),
      );
    } catch (error) {
      lastError = error;
      if (!isRetryableMeridianError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      const waitMs = Math.min(meridianRetryDelayMs(error, attempt), Math.max(0, remainingMs - 1));
      if (waitMs <= 0) break;
      await sleep(waitMs);
      attempt += 1;
    }
  }

  throw lastError || new Error(`${pathname} retry budget exhausted`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableMeridianStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableMeridianError(error) {
  if (isRetryableMeridianStatus(Number(error?.status || 0))) return true;
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();
  return name === "AbortError" ||
    message.includes("aborted") ||
    message.includes("fetch failed") ||
    message.includes("network");
}

function meridianRetryDelayMs(error, attempt) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 5_000);
}

async function meridianFetchWithTimeout(url, options, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal;
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromParent);
  }
}

async function meridianJsonOnce(pathname, options = {}, timeoutMs = null) {
  const res = await meridianFetchWithTimeout(`${getMeridianApiBase()}${pathname}`, options, timeoutMs);
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(payload?.error || `${pathname} ${res.status}`);
    error.status = res.status;
    error.payload = payload;
    error.retryAfter = res.headers.get("retry-after");
    throw error;
  }
  return payload;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64) {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx) {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const accounts = ix.accountKeyIndexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = []) {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

async function signAndSimulateRelayTransactions(serializedTxs, wallet, {
  label,
  allowedDebitMints = [],
  allowedSystemTransferDestinations = [],
  maxSolLoss = 0.05,
  requiredStaticAccounts = [],
} = {}) {
  const signed = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;

    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    const value = simulation.value;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`,
        );
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }

    signed.push(signedBase64);
  }

  return signed;
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

// Instead of asserting, clamp the requested range to only cover initialized bin arrays.
// Scans from the active bin outward; shrinks each side to the last initialized bin array.
// Returns { minBinId, maxBinId, clamped } — if clamped=true the caller must recalculate
// activeBinsBelow/activeBinsAbove from the new IDs.
async function clampRangeToInitializedBinArrays(pool, minBinId, maxBinId, activeBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization; refusing deploy.");
  }

  // Meteora DLMM: each bin array covers exactly 70 consecutive bins.
  const BIN_ARRAY_SIZE = 70;

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");

  // Bitmap extension check remains a hard error — it requires a separate account init.
  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }

  // Build sorted list of bin arrays with initialization status.
  const arrayInfos = indexes
    .map((idx, i) => ({ index: Number(idx.toString()), initialized: accounts[i] !== null }))
    .sort((a, b) => a.index - b.index);

  const missingCount = arrayInfos.filter((a) => !a.initialized).length;
  if (missingCount === 0) {
    return { minBinId, maxBinId, clamped: false };
  }

  const activeBinArrayIndex = Math.floor(activeBinId / BIN_ARRAY_SIZE);
  const activeBinArrayPos = arrayInfos.findIndex((a) => a.index === activeBinArrayIndex);

  // Active bin's own array must be initialized — if not, the pool itself is broken.
  if (activeBinArrayPos >= 0 && !arrayInfos[activeBinArrayPos].initialized) {
    throw new Error(`Deploy skipped: the active bin's bin array (index ${activeBinArrayIndex}) is uninitialized. Pool may be invalid.`);
  }

  // Scan lower side (inner → outer): stop at first uninitialized array.
  let newMinBinId = minBinId;
  const lowerStart = activeBinArrayPos >= 0 ? activeBinArrayPos - 1 : arrayInfos.length - 1;
  for (let i = lowerStart; i >= 0; i--) {
    if (!arrayInfos[i].initialized) {
      // Clamp above this missing array: first bin of the next (initialized) array.
      newMinBinId = (arrayInfos[i].index + 1) * BIN_ARRAY_SIZE;
      break;
    }
  }

  // Scan upper side (inner → outer): stop at first uninitialized array.
  let newMaxBinId = maxBinId;
  const upperStart = activeBinArrayPos >= 0 ? activeBinArrayPos + 1 : 0;
  for (let i = upperStart; i < arrayInfos.length; i++) {
    if (!arrayInfos[i].initialized) {
      // Clamp below this missing array: last bin of the previous (initialized) array.
      newMaxBinId = arrayInfos[i].index * BIN_ARRAY_SIZE - 1;
      break;
    }
  }

  const originalBinsBelow = activeBinId - minBinId;
  const originalBinsAbove = maxBinId - activeBinId;
  const newBinsBelow = activeBinId - newMinBinId;
  const newBinsAbove = newMaxBinId - activeBinId;

  if (newMinBinId > activeBinId || newMaxBinId < activeBinId) {
    throw new Error(
      `Deploy skipped: no initialized bin arrays available in the requested range around active bin ${activeBinId}.`,
    );
  }

  log(
    "deploy",
    `Range clamped to initialized bin arrays — ` +
    `bins_below ${originalBinsBelow}→${newBinsBelow}, bins_above ${originalBinsAbove}→${newBinsAbove} ` +
    `(${missingCount} missing bin array(s) trimmed from edges)`,
  );

  return { minBinId: newMinBinId, maxBinId: newMaxBinId, clamped: true };
}

function assertNoInitializeBinArrayInstructions(serializedTxs) {
  const offenders = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function assertNoInitializeBinArrayTransaction(tx) {
  const offenders = [];
  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(getDlmmProgramId())) continue;
    const discriminator = Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
    if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
      offenders.push("initializeBinArray");
    } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
      offenders.push("initializeBinArrayBitmapExtension");
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized) {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean);
  } catch {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean);
  }
}

function prependComputeBudget(tx, { units = 600_000, microLamports = 0 } = {}) {
  if (!tx || tx.instructions.length === 0) return tx;
  const existingComputeBudget = tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  if (existingComputeBudget) return tx;
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  tx.instructions.unshift(...instructions);
  return tx;
}

async function sendZapTransaction(tx, signers, label, txHashes) {
  if (!tx || tx.instructions.length === 0) return;
  assertNoInitializeBinArrayTransaction(tx);
  const txHash = await sendAndConfirmTransaction(getConnection(), tx, signers);
  txHashes.push(txHash);
  log("deploy", `Meteora Zap ${label}: ${txHash}`);
}

async function executeMeteoraZapDeploy({
  wallet,
  newPosition,
  poolAddress,
  pool,
  activeBinId,
  minBinId,
  maxBinId,
  strategyType,
  finalAmountY,
  liquidityXShare,
}) {
  const tokenYMint = pool.lbPair.tokenYMint;
  if (tokenYMint.toString() !== config.tokens.SOL) {
    throw new Error("Meteora Zap deploy currently supports SOL as token Y only.");
  }

  const { Zap, getJupiterQuote, DlmmDirectSwapQuoteRoute, DlmmSwapType } = await getZapSDK();
  const lbPair = new PublicKey(poolAddress);
  const amountIn = new BN(Math.floor(finalAmountY * 1e9).toString());
  const minDeltaId = minBinId - activeBinId;
  const maxDeltaId = maxBinId - activeBinId;
  const swapSlippageBps = 500;
  const maxAccounts = 48;
  const maxTransferAmountExtendPercentage = 10;
  const maxActiveBinSlippage = 10;
  const zapConfig = {
    jupiterApiUrl: "https://api.jup.ag",
    jupiterApiKey: config.jupiter?.apiKey || process.env.JUPITER_API_KEY || "",
  };
  const xShareBps = Math.max(1, Math.min(9999, Math.round(Number(liquidityXShare || 0) * 10_000)));
  const swapAmount = amountIn.mul(new BN(xShareBps)).div(new BN(10_000));
  if (swapAmount.lte(new BN(0)) || swapAmount.gte(amountIn)) {
    throw new Error("Invalid Meteora Zap liquidity divider; token-X share must be between 0% and 100%.");
  }

  log(
    "deploy",
    `Meteora Zap enabled: zapping ${finalAmountY} SOL into DLMM range ${minBinId}->${maxBinId}; ` +
      `converting ${(xShareBps / 100).toFixed(2)}% to token X`,
  );

  const jupiterQuote = await getJupiterQuote(
    tokenYMint,
    pool.lbPair.tokenXMint,
    swapAmount,
    maxAccounts,
    swapSlippageBps,
    false,
    true,
    true,
    zapConfig,
  );
  if (!jupiterQuote?.outAmount) {
    throw new Error("Meteora Zap failed to quote the configured SOL -> token X divider swap.");
  }

  const quoteOutAmount = new BN(String(jupiterQuote.outAmount));
  const directSwapEstimate = {
    swapType: DlmmSwapType.YToX,
    swapAmount,
    expectedOutput: quoteOutAmount,
    postSwapX: quoteOutAmount,
    postSwapY: amountIn.sub(swapAmount),
    quote: {
      inAmount: new BN(String(jupiterQuote.inAmount || swapAmount.toString())),
      outAmount: quoteOutAmount,
      route: DlmmDirectSwapQuoteRoute.Jupiter,
      originalQuote: jupiterQuote,
    },
  };

  const zap = new Zap(getConnection(), zapConfig);
  const zapParams = await zap.getZapInDlmmDirectParams({
    user: wallet.publicKey,
    lbPair,
    inputTokenMint: tokenYMint,
    amountIn,
    maxActiveBinSlippage,
    minDeltaId,
    maxDeltaId,
    strategy: strategyType,
    favorXInActiveId: true,
    maxAccounts,
    swapSlippageBps,
    maxTransferAmountExtendPercentage,
    directSwapEstimate,
  });
  const txs = await zap.buildZapInDlmmTransaction({
    ...zapParams,
    position: newPosition.publicKey,
  });

  const txHashes = [];
  await sendZapTransaction(txs.setupTransaction, [wallet], "setup", txHashes);
  for (const [index, swapTx] of txs.swapTransactions.entries()) {
    await sendZapTransaction(swapTx, [wallet], `swap ${index + 1}/${txs.swapTransactions.length}`, txHashes);
  }
  await sendZapTransaction(txs.ledgerTransaction, [wallet], "ledger", txHashes);
  prependComputeBudget(txs.zapInTransaction, { units: 600_000 });
  await sendZapTransaction(txs.zapInTransaction, [wallet, newPosition], "add liquidity", txHashes);
  await sendZapTransaction(txs.cleanUpTransaction, [wallet], "cleanup", txHashes);

  return txHashes;
}

async function executeMeteoraAtomicZapOutClose({
  wallet,
  poolAddress,
  pool,
  positionPubKey,
  positionData,
  fromBinId,
  toBinId,
}) {
  if (!config.api.meteoraZapEnabled) return null;

  const inputMint = pool.lbPair.tokenXMint.toString();
  const outputMint = pool.lbPair.tokenYMint.toString();
  if (!inputMint || inputMint === outputMint) return null;
  if (outputMint !== config.tokens.SOL) return null;

  const estimatedInput = new BN(String(positionData?.totalXAmount || "0"))
    .add(new BN(String(positionData?.feeX?.toString?.() || "0")));
  if (estimatedInput.lte(new BN(0))) return null;

  const { DLMM } = await getDLMM();
  const {
    Zap,
    getTokenProgramFromMint,
    getOrCreateATAInstruction,
    getTokenAccountBalance,
    getLbPairState,
    getDlmmRemainingAccounts,
    createDlmmSwapPayload,
    unwrapSOLInstruction,
    DLMM_PROGRAM_ID,
    AMOUNT_IN_DLMM_OFFSET,
  } = await getZapSDK();

  const connection = getConnection();
  const user = wallet.publicKey;
  const lbPairAddress = new PublicKey(poolAddress);
  const zapPool = await DLMM.create(connection, lbPairAddress, { skipSolWrappingOperation: true });
  const inputMintPk = zapPool.lbPair.tokenXMint;
  const outputMintPk = zapPool.lbPair.tokenYMint;
  const [inputTokenProgram, outputTokenProgram] = await Promise.all([
    getTokenProgramFromMint(connection, inputMintPk),
    getTokenProgramFromMint(connection, outputMintPk),
  ]);

  const [inputAta, outputAta] = await Promise.all([
    getOrCreateATAInstruction(connection, inputMintPk, user, user, true, inputTokenProgram),
    getOrCreateATAInstruction(connection, outputMintPk, user, user, true, outputTokenProgram),
  ]);

  const preInstructions = [];
  if (inputAta.ix) preInstructions.push(inputAta.ix);
  if (outputAta.ix) preInstructions.push(outputAta.ix);
  log(
    "close",
    `Meteora atomic zap-out accounts: in ${inputMint.slice(0, 8)}=${inputAta.ataPubkey.toString().slice(0, 8)} out ${outputMint.slice(0, 8)}=${outputAta.ataPubkey.toString().slice(0, 8)}`,
  );

  const setupTxHashes = [];
  const preUserTokenBalance = await getTokenAccountBalance(connection, inputAta.ataPubkey).catch(() => "0");
  const closeTxs = await zapPool.removeLiquidity({
    user,
    position: positionPubKey,
    fromBinId,
    toBinId,
    bps: new BN(10000),
    shouldClaimAndClose: true,
    skipUnwrapSOL: true,
  });
  const closeTxArray = Array.isArray(closeTxs) ? closeTxs : [closeTxs];
  if (closeTxArray.length !== 1) {
    throw new Error("Meteora atomic zap-out only supports single-transaction close; falling back.");
  }
  preInstructions.push(...closeTxArray[0].instructions);

  const binArrays = await zapPool.getBinArrayForSwap(true);
  const quote = zapPool.swapQuote(estimatedInput, true, new BN(500), binArrays, true);
  if (!quote?.minOutAmount || new BN(String(quote.minOutAmount)).lte(new BN(0))) {
    throw new Error("Meteora atomic zap-out could not quote a positive token X -> token Y output.");
  }

  const lbPairState = await getLbPairState(connection, lbPairAddress);
  const { remainingAccounts, remainingAccountsInfo } = await getDlmmRemainingAccounts(
    connection,
    lbPairAddress,
    user,
    inputAta.ataPubkey,
    outputAta.ataPubkey,
    inputTokenProgram,
    outputTokenProgram,
    lbPairState,
  );
  const payloadData = createDlmmSwapPayload(estimatedInput, new BN(String(quote.minOutAmount)), remainingAccountsInfo);
  const postInstructions = [];
  if (outputMint === config.tokens.SOL) {
    const unwrapIx = unwrapSOLInstruction(user, user);
    if (unwrapIx) postInstructions.push(unwrapIx);
  }

  const zap = new Zap(connection, {
    jupiterApiUrl: "https://api.jup.ag",
    jupiterApiKey: config.jupiter?.apiKey || process.env.JUPITER_API_KEY || "",
  });
  const tx = await zap.zapOut({
    userTokenInAccount: inputAta.ataPubkey,
    zapOutParams: {
      percentage: 100,
      offsetAmountIn: AMOUNT_IN_DLMM_OFFSET,
      preUserTokenBalance: new BN(String(preUserTokenBalance || "0")),
      maxSwapAmount: estimatedInput,
      payloadData,
    },
    remainingAccounts,
    ammProgram: DLMM_PROGRAM_ID,
    preInstructions,
    postInstructions,
  });
  prependComputeBudget(tx, { units: 800_000 });
  const txHash = await sendAndConfirmTransaction(connection, tx, [wallet]);
  log("close", "Meteora atomic zap-out close " + inputMint.slice(0, 8) + " -> " + outputMint.slice(0, 8) + ": " + txHash);
  return { tx: txHash, setup_txs: setupTxHashes, amount_in: estimatedInput.toString() };
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);

async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

function _extractIndicatorFields(payload, suffix) {
  if (!payload?.latest) return {};
  const n = (v) => (v != null && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
  const latest = payload.latest;
  return {
    [`rsi_${suffix}`]:        n(latest.rsi?.value),
    [`st_dir_${suffix}`]:     latest.supertrend?.direction ?? null,
    [`st_val_${suffix}`]:     n(latest.supertrend?.value),
    [`bb_upper_${suffix}`]:   n(latest.bollinger?.upper),
    [`bb_mid_${suffix}`]:     n(latest.bollinger?.middle),
    [`bb_lower_${suffix}`]:   n(latest.bollinger?.lower),
  };
}

async function fetchIndicatorSnapshot(mint, prefix = "") {
  const nullResult = {
    [`${prefix}rsi_5m`]: null, [`${prefix}rsi_15m`]: null,
    [`${prefix}st_dir_5m`]: null, [`${prefix}st_dir_15m`]: null,
    [`${prefix}st_val_5m`]: null, [`${prefix}st_val_15m`]: null,
    [`${prefix}bb_upper_5m`]: null, [`${prefix}bb_mid_5m`]: null, [`${prefix}bb_lower_5m`]: null,
    [`${prefix}bb_upper_15m`]: null, [`${prefix}bb_mid_15m`]: null, [`${prefix}bb_lower_15m`]: null,
  };
  if (!mint) return nullResult;
  try {
    const [p5, p15] = await Promise.all([
      fetchChartIndicatorsForMint(mint, { interval: "5_MINUTE" }).catch(() => null),
      fetchChartIndicatorsForMint(mint, { interval: "15_MINUTE" }).catch(() => null),
    ]);
    const f5  = _extractIndicatorFields(p5,  `${prefix}5m`);
    const f15 = _extractIndicatorFields(p15, `${prefix}15m`);
    return { ...f5, ...f15 };
  } catch {
    return nullResult;
  }
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  price_vs_ath_pct,
  initial_value_usd,
  // entry market conditions (injected by executor safety checks)
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  // downside_pct / upside_pct are the primary range inputs. bins_below / bins_above are
  // accepted for manual/legacy calls but cannot override configured pct defaults.
  let activeBinsBelow = bins_below ?? MIN_SAFE_BINS_BELOW; // placeholder; overridden by pct block below
  let activeBinsAbove = bins_above ?? 0;
  // Always apply the configured pct defaults unless a pct was explicitly passed.
  // bins_below/bins_above are ignored in favour of the config when downside/upside_pct is unset.
  if (downside_pct == null) {
    downside_pct = config.strategy.defaultDownsidePct ?? 60;
  }
  if (upside_pct == null) {
    upside_pct = config.strategy.defaultUpsidePct ?? 0;
  }
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  // if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
  //   throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  // }

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }

  // Authoritative duplicate-token guard using the on-chain derived baseMint.
  // The LLM frequently passes pool_address as base_mint arg, making the executor.js
  // pre-check unreliable. This check uses the real mint from the pool object.
  // Duplicate-token check: block deploying to the same base token twice
  if (!config.risk.allowMultiplePositionsPerToken) {
    const livePositions = await getMyPositions({ force: true, silent: true });
    const alreadyHasMint = (livePositions?.positions ?? []).some((p) => p.base_mint === baseMint);
    if (alreadyHasMint) {
      log("deploy", `Duplicate token blocked: ${baseMint.slice(0, 8)} already held in an open position`);
      return { success: false, error: `Already holding token ${baseMint.slice(0, 8)} in an open position.` };
    }
  }

  // Indicator pre-check using the real on-chain baseMint — runs here (not executor.js)
  // so the mint is always authoritative, never confused with the pool address by the LLM.
  if (config.indicators?.enabled) {
    try {
      const confirmation = await confirmIndicatorPreset({
        mint: baseMint,
        side: "entry",
        refresh: true,
        enabled: true,
        preset: config.indicators.entryPreset,
        intervals: config.indicators.intervals,
        requireAllIntervals: config.indicators.requireAllIntervals ?? false,
      });
      if (confirmation.enabled && !confirmation.confirmed && !confirmation.skipped) {
        log("deploy", `Indicator pre-check blocked deploy for ${baseMint.slice(0, 8)}: ${confirmation.reason}`);
        return { success: false, error: `Indicator check failed: ${confirmation.reason}` };
      }
    } catch (e) {
      log("deploy", `Indicator pre-check failed (non-blocking): ${e.message}`);
    }
  }

  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    // Short-circuit: upside_pct=0 must always produce bins_above=0.
    // getBinIdFromPrice(activePrice, binStep, false) can round to activeBinId+1
    // due to bin-boundary math, causing a spurious pre-deploy swap.
    if (upsidePct === 0) {
      activeBinsAbove = 0;
    } else {
      const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);
      activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
    }
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: pass amount_y (SOL) only — amount_x is auto-calculated from bins_above.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  // isSingleSidedSol: true only when no bins above (no token X side needed)
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0 && activeBinsAbove === 0;
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = MIN_SAFE_BINS_BELOW;
  let totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  const zapRangeEligible = !!config.api.meteoraZapEnabled && finalAmountX === 0 && activeBinsAbove > 0;
  if (zapRangeEligible && totalBins > METEORA_ZAP_MAX_RANGE_BINS) {
    const capped = capZapRangeToDivider({
      activeBinsBelow,
      activeBinsAbove,
      downsidePct: downside_pct,
      upsidePct: upside_pct,
      totalBins,
    });
    if (capped.capped) {
      log(
        "deploy",
        `Meteora Zap range capped to ${METEORA_ZAP_MAX_RANGE_BINS} bins by divider: ` +
          `bins_below ${activeBinsBelow}->${capped.activeBinsBelow}, bins_above ${activeBinsAbove}->${capped.activeBinsAbove}`,
      );
      activeBinsBelow = capped.activeBinsBelow;
      activeBinsAbove = capped.activeBinsAbove;
      totalBins = capped.totalBins;
    }
  }

  let liquidityDivider = getLiquidityDivider({
    downsidePct: downside_pct,
    upsidePct: upside_pct,
    activeBinsAbove,
    totalBins,
  });

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        liquidity_divider: {
          source: liquidityDivider.source,
          sol_share: liquidityDivider.yShare,
          token_x_share: liquidityDivider.xShare,
        },
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  let isWideRange = totalBins > 69;
  let minBinId = activeBin.binId - activeBinsBelow;
  let maxBinId = activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }

  // Clamp range to initialized bin arrays instead of hard-failing.
  // If outer bin arrays are uninitialized, shrinks from each edge to the nearest initialized one.
  const clampResult = await clampRangeToInitializedBinArrays(pool, minBinId, maxBinId, activeBin.binId);
  if (clampResult.clamped) {
    minBinId = clampResult.minBinId;
    maxBinId = clampResult.maxBinId;
    activeBinsBelow = activeBin.binId - minBinId;
    activeBinsAbove = maxBinId - activeBin.binId;
    totalBins = activeBinsBelow + activeBinsAbove;
    isWideRange = totalBins > 69;
  }

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  // For bins_above > 0, we need token X for the upper bins.
  // The configured downside/upside pct values act as the liquidity divider:
  // 40 below / 10 above means 80% stays SOL-side and 20% converts to token X.
  liquidityDivider = getLiquidityDivider({
    downsidePct: downside_pct,
    upsidePct: upside_pct,
    activeBinsAbove,
    totalBins,
  });
  const percentX = liquidityDivider.xShare;
  const useMeteoraZap = shouldUseMeteoraZapForDeploy({ activeBinsAbove, finalAmountX, isWideRange });
  // solForX: fraction of the deploy amount to convert to token X.
  // We swap 10% MORE than the strategy needs (×1.10) so the wallet retains a 10% surplus
  // over what we tell the SDK to deploy. The SDK sets its on-chain ceiling to
  // maxDepositXAmount = sdkXInput × 1.10; by passing (received / 1.10) to the SDK,
  // that ceiling equals exactly what the wallet holds — preventing TransferChecked failures
  // when the active bin drifts slightly between TX build and execution.
  const solForX = activeBinsAbove > 0 ? finalAmountY * percentX * 1.10 : 0;
  // effectiveAmountY: SOL remaining for the lower bins after the X portion is reserved
  const effectiveAmountY = finalAmountY - solForX;

  let totalXLamports = new BN(0);
  if (!useMeteoraZap && !shouldUseLpAgentRelayForDeploy() && activeBinsAbove > 0) {
    const baseMintAddress = pool.lbPair.tokenXMint.toString();
    log("deploy", `bins_above=${activeBinsAbove}: swapping ${solForX.toFixed(4)} SOL → base token before deploy`);
    const swapResult = await swapToken({
      input_mint: "So11111111111111111111111111111111111111112", // SOL
      output_mint: baseMintAddress,
      amount: solForX,
    });
    if (!swapResult.success) {
      throw new Error(`Pre-deploy swap SOL→base token failed: ${swapResult.error}`);
    }
    // swapToken returns amount_out in raw token units.
    // We pass (received × 10/11) ≈ received/1.10 to the SDK so that the SDK's on-chain ceiling
    // (maxDepositXAmount = sdkInput × 1.10) equals exactly what the wallet holds.
    // The remaining ~9% stays in the wallet as the slippage buffer and is auto-swapped back
    // to SOL after the position closes.
    const xReceived = BigInt(String(swapResult.amount_out));
    const xToPassSDK = xReceived * 10n / 11n; // floor(received / 1.10)
    totalXLamports = new BN(String(xToPassSDK));
    log("deploy", `Pre-deploy swap succeeded: received ${swapResult.amount_out} raw base token units (passing ${xToPassSDK} to SDK)`);
  } else if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  const totalYLamports = new BN(Math.floor((useMeteoraZap ? finalAmountY : effectiveAmountY) * 1e9));

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await meridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getMeridianHeaders(),
        body: JSON.stringify({
          agentId: config.hiveMind.agentId || "agent-local",
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: activeBinsAbove > 0 ? effectiveAmountY : finalAmountY,
          amountX: activeBinsAbove > 0 ? solForX : finalAmountX,
          percentX: percentX > 0 ? percentX : (finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0),
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await meridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getMeridianHeaders(),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        const signalSnapshot = config.darwin?.enabled
          ? getAndClearStagedSignals(pool_address, baseMint)
          : null;
        const athPct = price_vs_ath_pct != null ? price_vs_ath_pct : (signalSnapshot?.price_vs_ath_pct ?? null);
        const entryRsi = await fetchIndicatorSnapshot(baseMint);
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          price_vs_ath_pct: athPct,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
          signal_snapshot: { ...(signalSnapshot || {}), price_vs_ath_pct: athPct, ...entryRsi },
          entry_mcap,
          entry_tvl,
          entry_volume,
          entry_holders,
        });
        // Mirror entry to position-memory.json for dashboard
        const tracked1 = getTrackedPosition(positionAddress);
        if (tracked1) {
          recordPositionEntry({
            position: positionAddress,
            pool: pool_address,
            pool_name,
            tracked: tracked1,
            signal_snapshot: { ...(signalSnapshot || {}), price_vs_ath_pct: athPct, ...entryRsi },
            entry_price: activePrice,
          });
        }
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }


  const wallet = getWallet();
  const newPosition = Keypair.generate();

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  try {
    const txHashes = [];

    if (useMeteoraZap) {
      const zapTxHashes = await executeMeteoraZapDeploy({
        wallet,
        newPosition,
        poolAddress: pool_address,
        pool,
        activeBinId: activeBin.binId,
        minBinId,
        maxBinId,
        strategyType,
        finalAmountY,
        liquidityXShare: percentX,
      });
      txHashes.push(...zapTxHashes);
    } else if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      for (let i = 0; i < createTxArray.length; i++) {
        const signers = i === 0 ? [wallet, newPosition] : [wallet];
        const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers);
        txHashes.push(txHash);
        log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
      }

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 10, // 10%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      for (let i = 0; i < addTxArray.length; i++) {
        const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet]);
        txHashes.push(txHash);
        log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
      }
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1000, // 10% in bps
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]);
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    const signalSnapshot = config.darwin?.enabled
      ? getAndClearStagedSignals(pool_address, baseMint)
      : null;
    const athPct = price_vs_ath_pct != null ? price_vs_ath_pct : (signalSnapshot?.price_vs_ath_pct ?? null);
    const entryRsi = await fetchIndicatorSnapshot(baseMint);
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility: normalizedVolatility,
      fee_tvl_ratio,
      organic_score,
      price_vs_ath_pct: athPct,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd,
      signal_snapshot: { ...(signalSnapshot || {}), price_vs_ath_pct: athPct, ...entryRsi },
      entry_mcap,
      entry_tvl,
      entry_volume,
      entry_holders,
    });
    // Mirror entry to position-memory.json for dashboard
    const tracked2 = getTrackedPosition(newPosition.publicKey.toString());
    if (tracked2) {
      recordPositionEntry({
        position: newPosition.publicKey.toString(),
        pool: pool_address,
        pool_name,
        tracked: tracked2,
        signal_snapshot: { ...(signalSnapshot || {}), price_vs_ath_pct: athPct, ...entryRsi },
        entry_price: activePrice,
      });
    }

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean),
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
      meteora_zap: useMeteoraZap,
      liquidity_divider: {
        source: liquidityDivider.source,
        sol_share: liquidityDivider.yShare,
        token_x_share: liquidityDivider.xShare,
      },
      base_mint: baseMint,
    };
  } catch (error) {
    log("deploy_error", error.message);
    // Return base_mint so executor can swap back any pre-swapped tokens
    return { success: false, error: error.message, base_mint: activeBinsAbove > 0 ? baseMint : undefined };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  // Prefer the public-infra path (RPC + Jupiter + Meteora deposits) used by getMyPositions.
  if (config.pnl.source === "rpc") {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
        };
      }
    } catch (error) {
      log("pnl_warn", `RPC PnL lookup failed; falling back to direct Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode
      ? safeNum(p.unrealizedPnl?.balancesSol)
      : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode
      ? maybeNum(p.pnlSolPctChange)
      : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);
    return {
      pnl_usd:           roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_pct:           roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "local_price_vs_ath_pct",
  // entry indicators
  "rsi_5m", "rsi_15m",
  "st_dir_5m", "st_dir_15m",
  "st_val_5m", "st_val_15m",
  "bb_upper_5m", "bb_mid_5m", "bb_lower_5m",
  "bb_upper_15m", "bb_mid_15m", "bb_lower_15m",
  // exit indicators
  "exit_rsi_5m", "exit_rsi_15m",
  "exit_st_dir_5m", "exit_st_dir_15m",
  "exit_st_val_5m", "exit_st_val_15m",
  "exit_bb_upper_5m", "exit_bb_mid_5m", "exit_bb_lower_5m",
  "exit_bb_upper_15m", "exit_bb_mid_15m", "exit_bb_lower_15m",
  // exit pool fundamentals (from Meteora pool API at close time)
  "exit_fee_tvl_ratio", "exit_fee_window", "exit_volume", "exit_tvl",
];

function resolvePerformanceSignalSnapshot({ poolAddress, baseMint, tracked }) {
  const staged = config.darwin?.enabled
    ? getAndClearStagedSignals(poolAddress, baseMint)
    : null;
  const snapshot = {
    ...(staged || {}),
    ...(tracked?.signal_snapshot || {}),
  };

  if (baseMint && snapshot.base_mint == null) snapshot.base_mint = baseMint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && tracked?.[field] != null) {
      snapshot[field] = tracked[field];
    }
  }

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function getClosedPnlValue(posEntry, solMode = false) {
  if (solMode) {
    // Prefer computing SOL PnL from on-chain deposit/withdrawal/fee data.
    // The API's pnlSol field is derived from USD/solPrice and is inaccurate
    // (e.g. when the token X side crashes in USD terms between deposit and close).
    const depositSol     = maybeNum(posEntry?.allTimeDeposits?.total?.sol);
    const withdrawalSol  = maybeNum(posEntry?.allTimeWithdrawals?.total?.sol);
    const feesSol        = maybeNum(posEntry?.allTimeFees?.total?.sol);
    if (depositSol != null && depositSol > 0 && withdrawalSol != null) {
      return (withdrawalSol + (feesSol ?? 0)) - depositSol;
    }
    return maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0;
  }
  return maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0;
}

function getClosedPnlPct(posEntry, solMode = false) {
  if (solMode) {
    // Use true on-chain SOL flows for the percentage — avoids the API's pnlSolPctChange
    // which is pnlUsd / solPrice and gives wildly wrong results when token X drops in USD.
    const depositSol     = maybeNum(posEntry?.allTimeDeposits?.total?.sol);
    const withdrawalSol  = maybeNum(posEntry?.allTimeWithdrawals?.total?.sol);
    const feesSol        = maybeNum(posEntry?.allTimeFees?.total?.sol);
    if (depositSol != null && depositSol > 0 && withdrawalSol != null) {
      const pnlSol = (withdrawalSol + (feesSol ?? 0)) - depositSol;
      return (pnlSol / depositSol) * 100;
    }
    // Fall back to API-reported percentages only if on-chain data unavailable.
    const reported = maybeNum(posEntry?.pnlSolPctChange) ?? maybeNum(posEntry?.pnl?.percentNative);
    if (reported != null) return reported;
    const pnl     = maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0;
    const deposit = maybeNum(posEntry?.allTimeDeposits?.total?.sol);
    return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
  }

  const reported = maybeNum(posEntry?.pnlPctChange) ?? maybeNum(posEntry?.pnl?.percent);
  if (reported != null) return reported;
  const pnl     = maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0;
  const deposit = maybeNum(posEntry?.allTimeDeposits?.total?.usd);
  return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
}

function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchRawOpenPositionsFromMeridian({ walletAddress, agentId }) {
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  const payload = await meridianJson(`/positions/open/raw?${search.toString()}`, {
    headers: config.api.publicApiKey ? { "x-api-key": config.api.publicApiKey } : {},
    retry: {
      maxElapsedMs: 30_000,
      perAttemptTimeoutMs: 30_000,
    },
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const byPosition = {};
  for (const row of rows) {
    const addr = row?.position || row?.id || row?.tokenId;
    if (addr) byPosition[addr] = row;
  }
  return {
    ...payload,
    data: rows,
    byPosition,
  };
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false, wallet_address = null } = {}) {
  let walletOverride = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (useLocalWallet && _positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = walletOverride || getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async () => { try {
    // ── Primary path: public infra (on-chain RPC + Jupiter + Meteora deposits) ──
    // No LPAgent / agentmeridian dependency, so the poller runs aggressively on
    // fully public resources. Falls through to the Meteora-API path on any error.
    if (config.pnl.source === "rpc") {
      try {
        if (!silent) log("positions", `Computing PnL from RPC (${config.pnl.rpcUrl})...`);
        const rpcResult = await computePositions(walletAddress);
        if (useLocalWallet) {
          syncOpenPositions(rpcResult.positions.map((p) => p.position));
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;
      } catch (error) {
        log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${error.message}`);
      }
    }

    // ── Fallback path: Meteora portfolio + /pnl APIs (no LPAgent) ──
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = {}; // LPAgent removed — Meteora binData only

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;

        if (isOOR) {
          const oorDirection = activeBin != null && lowerBin != null && upperBin != null
            ? activeBin > upperBin ? 'above' : 'below'
            : null;
          markOutOfRange(positionAddress, oorDirection);
        } else {
          markInRange(positionAddress);
        }
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        // Gate PnL rules ONLY when the tick is genuinely unpriceable (no real number
        // from either method — e.g. missing deposits / data outage). Reported-vs-derived
        // divergence is normal noise on volatile pools, so it is logged but NOT gated —
        // gating on it froze all exits (stop-loss/trailing/close) and stranded positions.
        const pnlPctSuspicious = reportedPnlPct == null && derivedPnlPct == null;
        if (pnlPctSuspicious) {
          log("positions_warn", `Unpriceable pnl_pct for ${positionAddress.slice(0, 8)}: no valid reported/derived value this tick — PnL rules paused`);
        } else if (pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5)) {
          // Informational only — does not gate rules.
          log("positions_warn", `pnl_pct divergence for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)} (informational)`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
          slot:               tracked?.slot ?? "main",
        });
      }
    }

    const result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      syncOpenPositions(positions.map(p => p.position));
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    if (useLocalWallet) _positionsInflight = null;
  }
  };

  if (useLocalWallet) {
    _positionsInflight = loadPositions();
    return _positionsInflight;
  }

  return loadPositions();
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const solMode = config.management.solMode;
      const unclaimedValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
          : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd)
        : 0;
      const currentValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.balancesSol)
          : safeNum(p.unrealizedPnl?.balances)
        : 0;
      const reportedPnlPct = p
        ? solMode
          ? maybeNum(p.pnlSolPctChange)
          : maybeNum(p.pnlPctChange)
        : null;
      const derivedPnlPct = p ? deriveOpenPnlPct(p, solMode) : null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: roundNum(unclaimedValue, 4),
        total_value_usd:    roundNum(currentValue, 4),
        pnl_usd:            roundNum(p ? (solMode ? p.pnlSol : p.pnlUsd) : 0, 4),
        pnl_pct:            roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelayForClose()) {
      let relaySubmitted = false;
      try {
        const pool = await getPool(poolAddress);
        const relayAllowedDebitMints = [
          pool.lbPair.tokenXMint.toString(),
          pool.lbPair.tokenYMint.toString(),
          config.tokens.SOL,
        ];
        const livePositions = await getMyPositions({ force: true, silent: true });
        const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
        const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
        const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
        const closeOutput = "allToken1";

        const order = await meridianJson("/execution/zap-out/order", {
          method: "POST",
          headers: getMeridianHeaders(),
          body: JSON.stringify({
            agentId: config.hiveMind.agentId || "agent-local",
            idempotencyKey: `close:${position_address}:10000`,
            positionId: position_address,
            owner: wallet.publicKey.toString(),
            bps: 10000,
            slippageBps: 5000,
            output: closeOutput,
            provider: "OKX",
            type: "meteora",
            fromBinId: closeFromBinId,
            toBinId: closeToBinId,
          }),
        });

        const closeUnsigned = order?.order?.transactions?.close || [];
        const swapUnsigned = order?.order?.transactions?.swap || [];
        if (closeUnsigned.length + swapUnsigned.length === 0) {
          throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
        }

        const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
          label: "zap-out close",
          allowedDebitMints: relayAllowedDebitMints,
          maxSolLoss: 0.05,
          requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
        });
        const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
          label: "zap-out swap",
          allowedDebitMints: relayAllowedDebitMints,
          maxSolLoss: 0.05,
          requiredStaticAccounts: [wallet.publicKey.toString()],
        });

        relaySubmitted = true;
        const submit = await meridianJson("/execution/zap-out/submit", {
          method: "POST",
          headers: getMeridianHeaders(),
          body: JSON.stringify({
            requestId: order.requestId,
            lastValidBlockHeight: order?.order?.lastValidBlockHeight,
            transactions: {
              close: closeSigned,
              swap: swapSigned,
            },
          }),
        });

        const claimTxHashes = [];
        const closeTxHashes = normalizeExecutionSignatures(submit);
        const txHashes = [...claimTxHashes, ...closeTxHashes];

        await new Promise((resolve) => setTimeout(resolve, 5000));
        _positionsCacheAt = 0;

        let closedConfirmed = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const refreshed = await getMyPositions({ force: true, silent: true });
            const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
            if (!stillOpen) {
              closedConfirmed = true;
              break;
            }
            log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
          } catch (e) {
            log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
          }
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        if (!closedConfirmed) {
          return {
            success: false,
            error: "Close submit succeeded but position still appears open after verification window",
            position: position_address,
            pool: poolAddress,
            close_txs: closeTxHashes,
            txs: txHashes,
          };
        }

        recordClose(position_address, reason || "agent decision");

        if (tracked) {
          const deployedAt = new Date(tracked.deployed_at).getTime();
          const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
          let minutesOOR = 0;
          if (tracked.out_of_range_since) {
            minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
          }

          let pnlUsd = 0;
          let pnlTrueUsd = 0;
          let pnlPct = 0;
          let finalValueUsd = 0;
          let initialUsd = 0;
          let pnlSol = null;
          let finalValueSol = null;
          let initialSol = null;
          let feesSol = null;
          let feesUsd = tracked.total_fees_claimed_usd || 0;
          try {
            const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
            for (let attempt = 0; attempt < 6; attempt++) {
              const res = await fetch(closedUrl);
              if (res.ok) {
                const data = await res.json();
                const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
                if (posEntry) {
                  pnlTrueUsd = safeNum(posEntry.pnlUsd);
                  pnlUsd = config.management.solMode ? getClosedPnlValue(posEntry, true) : pnlTrueUsd;
                  pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
                  finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                  initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                  finalValueSol = maybeNum(posEntry.allTimeWithdrawals?.total?.sol);
                  initialSol = maybeNum(posEntry.allTimeDeposits?.total?.sol);
                  feesSol = maybeNum(posEntry.allTimeFees?.total?.sol);
                  pnlSol = initialSol != null && finalValueSol != null ? finalValueSol + (feesSol ?? 0) - initialSol : maybeNum(posEntry.pnlSol);
                  feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                  break;
                }
              }
              if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
            }
          } catch (e) {
            log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
          }

          const closeBaseMint = livePosition?.base_mint || pool.lbPair.tokenXMint.toString();
          const signalSnapshot = resolvePerformanceSignalSnapshot({
            poolAddress,
            baseMint: closeBaseMint,
            tracked,
          });
          const exitIndicators = await fetchIndicatorSnapshot(closeBaseMint, "exit_");
          const snapshotWithExit = { ...(signalSnapshot || {}), ...exitIndicators };

          let exitMarket = {};
          try {
            const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
            const ep = exitDetail?.data?.[0];
            if (ep) {
              const exitMcap = parseFloat(ep?.token_x?.market_cap) || null;
              const exitTvl = parseFloat(ep?.tvl ?? ep?.active_tvl) || null;
              const exitVolume = parseFloat(ep?.volume) || null;
              const exitFeeTvlRatio = parseFloat(ep?.fee_active_tvl_ratio) || null;
              const exitFeeWindow = parseFloat(ep?.fee) || null;
              exitMarket = {
                exit_mcap: exitMcap,
                exit_tvl: exitTvl,
                exit_volume: exitVolume,
              };
              Object.assign(snapshotWithExit, {
                // exit.signal_snapshot should describe the close-time market;
                // keep exit_* aliases for compatibility with lessons/performance reads.
                mcap: exitMcap,
                tvl: exitTvl,
                volume: exitVolume,
                fee_tvl_ratio: exitFeeTvlRatio,
                fee_window: exitFeeWindow,
                exit_mcap: exitMcap,
                exit_fee_tvl_ratio: exitFeeTvlRatio,
                exit_fee_window: exitFeeWindow,
                exit_volume: exitVolume,
                exit_tvl: exitTvl,
              });
            }
          } catch { /* non-blocking */ }

          await recordPerformance({
            position: position_address,
            pool: poolAddress,
            pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
            base_mint: closeBaseMint,
            strategy: tracked.strategy,
            bin_range: tracked.bin_range,
            bin_step: tracked.bin_step || null,
            volatility: tracked.volatility ?? null,
            fee_tvl_ratio: tracked.fee_tvl_ratio || null,
            organic_score: tracked.organic_score || null,
            amount_sol: tracked.amount_sol,
            fees_earned_usd: feesUsd,
            final_value_usd: finalValueUsd,
            initial_value_usd: initialUsd,
            minutes_in_range: minutesHeld - minutesOOR,
            minutes_held: minutesHeld,
            close_reason: reason || "agent decision",
            signal_snapshot: snapshotWithExit,
            entry_mcap: tracked.entry_mcap ?? null,
            entry_tvl: tracked.entry_tvl ?? null,
            entry_volume: tracked.entry_volume ?? null,
            entry_holders: tracked.entry_holders ?? null,
            ...exitMarket,
          });

          // Also record to position-memory.json for dashboard
          recordPositionExit(position_address, reason, null, {
            active_bin: activeBin?.binId ?? tracked?.active_bin_at_deploy ?? null,
            pnl_pct: pnlPct,
            peak_pnl_pct: tracked?.peak_pnl_pct ?? null,
            trough_pnl_pct: tracked?.trough_pnl_pct ?? null,
            pnl_usd: pnlTrueUsd, // always true USD, not SOL-mode adjusted
            pnl_sol: pnlSol,
            initial_value_usd: initialUsd,
            initial_value_sol: initialSol,
            final_value_usd: finalValueUsd,
            final_value_sol: finalValueSol,
            fees_earned_usd: feesUsd,
            fees_earned_sol: feesSol,
            minutes_in_range: minutesHeld - minutesOOR,
            minutes_held: minutesHeld,
            signal_snapshot: snapshotWithExit,
          });

          appendDecision({
            type: "close",
            actor: "MANAGER",
            pool: poolAddress,
            pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
            position: position_address,
            summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
            reason: reason || "agent decision",
            risks: [
              minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
              tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
            ].filter(Boolean),
            metrics: {
              pnl_usd: pnlUsd,
              pnl_pct: pnlPct,
              fees_usd: feesUsd,
              minutes_held: minutesHeld,
            },
          });

          return {
            success: true,
            relay: true,
            request_id: order.requestId,
            position: position_address,
            pool: poolAddress,
            pool_name: tracked.pool_name || poolMeta.name || null,
            claim_txs: claimTxHashes,
            close_txs: closeTxHashes,
            txs: txHashes,
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            base_mint: closeBaseMint,
          };
        }
      } catch (relayError) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (config.api.meteoraZapEnabled) {
        log("close", "Step 1: Skipping separate claim — Meteora Zap close will claim atomically");
      } else if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    let positionDataForClose = null;
    try {
      positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    let zapOutResult = null;
    if (hasLiquidity) {
      if (config.api.meteoraZapEnabled) {
        try {
          zapOutResult = await executeMeteoraAtomicZapOutClose({
            wallet,
            poolAddress,
            pool,
            positionPubKey,
            positionData: positionDataForClose?.positionData,
            fromBinId: closeFromBinId,
            toBinId: closeToBinId,
          });
          if (zapOutResult?.tx) {
            closeTxHashes.push(...(zapOutResult.setup_txs || []), zapOutResult.tx);
          }
        } catch (e) {
          log("close_warn", "Meteora atomic zap-out close failed; falling back to local close + Jupiter auto-swap: " + e.message);
          zapOutResult = null;
        }
      }

      if (!zapOutResult?.tx) {
        log("close", `Step 2: Removing liquidity and closing account`);
        const closeTx = await pool.removeLiquidity({
          user: wallet.publicKey,
          position: positionPubKey,
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
          bps: new BN(10000),
          shouldClaimAndClose: true,
        });

        for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
          const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
          closeTxHashes.push(txHash);
        }
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let pnlSol = null;
      let finalValueSol = null;
      let initialSol = null;
      let feesSol = null;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = safeNum(posEntry.pnlUsd);
              const nextPnlValue = config.management.solMode ? getClosedPnlValue(posEntry, true) : nextPnlUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
              const nextFinalValueSol = maybeNum(posEntry.allTimeWithdrawals?.total?.sol);
              const nextInitialSol = maybeNum(posEntry.allTimeDeposits?.total?.sol);
              const nextFeesSol = maybeNum(posEntry.allTimeFees?.total?.sol);
              const nextPnlSol = nextInitialSol != null && nextFinalValueSol != null ? nextFinalValueSol + (nextFeesSol ?? 0) - nextInitialSol : maybeNum(posEntry.pnlSol);

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlTrueUsd    = nextPnlUsd;
                pnlUsd        = nextPnlValue;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                pnlSol        = nextPnlSol;
                finalValueSol = nextFinalValueSol;
                initialSol    = nextInitialSol;
                feesSol       = nextFeesSol;
                feesUsd       = nextFeesUsd;
                const depositSolDbg    = posEntry?.allTimeDeposits?.total?.sol;
                const withdrawalSolDbg = posEntry?.allTimeWithdrawals?.total?.sol;
                const feesSolDbg       = posEntry?.allTimeFees?.total?.sol;
                const solDebug = config.management.solMode && depositSolDbg != null
                  ? ` | sol_in=${Number(depositSolDbg).toFixed(4)} sol_out=${Number(withdrawalSolDbg ?? 0).toFixed(4)} fees_sol=${Number(feesSolDbg ?? 0).toFixed(4)}`
                  : "";
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(4)} ${config.management.solMode ? "SOL" : "USD"} (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)} USD, deposited=${initialUsd.toFixed(2)} USD${solDebug}`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlTrueUsd    = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlUsd        = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : pnlTrueUsd;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
            if (!config.management.solMode) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      const closeBaseMint = pool.lbPair.tokenXMint.toString();
      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });
      const exitIndicators = await fetchIndicatorSnapshot(closeBaseMint, "exit_");
      const snapshotWithExit = { ...(signalSnapshot || {}), ...exitIndicators };

      let exitMarket = {};
      try {
        const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
        const ep = exitDetail?.data?.[0];
        if (ep) {
          const exitMcap = parseFloat(ep?.token_x?.market_cap) || null;
          const exitTvl = parseFloat(ep?.tvl ?? ep?.active_tvl) || null;
          const exitVolume = parseFloat(ep?.volume) || null;
          const exitFeeTvlRatio = parseFloat(ep?.fee_active_tvl_ratio) || null;
          const exitFeeWindow = parseFloat(ep?.fee) || null;
          exitMarket = {
            exit_mcap: exitMcap,
            exit_tvl: exitTvl,
            exit_volume: exitVolume,
          };
          Object.assign(snapshotWithExit, {
            // exit.signal_snapshot should describe the close-time market;
            // keep exit_* aliases for compatibility with lessons/performance reads.
            mcap: exitMcap,
            tvl: exitTvl,
            volume: exitVolume,
            fee_tvl_ratio: exitFeeTvlRatio,
            fee_window: exitFeeWindow,
            exit_mcap: exitMcap,
            exit_fee_tvl_ratio: exitFeeTvlRatio,
            exit_fee_window: exitFeeWindow,
            exit_volume: exitVolume,
            exit_tvl: exitTvl,
          });
        }
      } catch { /* non-blocking */ }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: snapshotWithExit,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
        ...exitMarket,
      });

      recordPositionExit(position_address, reason, null, {
        active_bin: pool.lbPair.activeId ?? tracked?.active_bin_at_deploy ?? null,
        pnl_pct: pnlPct,
        peak_pnl_pct: tracked?.peak_pnl_pct ?? null,
        trough_pnl_pct: tracked?.trough_pnl_pct ?? null,
        pnl_usd: pnlTrueUsd, // always true USD, not SOL-mode adjusted
        pnl_sol: pnlSol,
        initial_value_usd: initialUsd,
        initial_value_sol: initialSol,
        final_value_usd: finalValueUsd,
        final_value_sol: finalValueSol,
        fees_earned_usd: feesUsd,
        fees_earned_sol: feesSol,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        signal_snapshot: snapshotWithExit,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: zapOutResult?.tx ? undefined : closeBaseMint,
        meteora_zap_out: !!zapOutResult?.tx,
        zap_out_txs: zapOutResult?.tx ? [...(zapOutResult.setup_txs || []), zapOutResult.tx] : [],
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: zapOutResult?.tx ? undefined : pool.lbPair.tokenXMint.toString(),
      meteora_zap_out: !!zapOutResult?.tx,
      zap_out_txs: zapOutResult?.tx ? [...(zapOutResult.setup_txs || []), zapOutResult.tx] : [],
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
